#!/usr/bin/env node
// An MCP server that answers ONE question: which ACP review lanes exist here,
// and what does each one still need on THIS machine. The per-machine overrides
// `TMUX_TEAMS_REVIEW_<ID>_SETTINGS` and `_ENV_FILE` had worked since 2026-08-13
// and nothing surfaced them — "read the comment at review-profiles.mjs" is a
// document, not an answer.
//
// ## Credentials: it READS them and never returns them
//
// Deciding whether a lane is configured means calling `buildAcpLaunch`, which
// reads the settings JSON and the credential file and copies provider secrets
// from the environment. Do not claim otherwise: discarding a value you asked
// for is not declining to read it (Master, 2026-08-16).
//
// The containment is OUTBOUND and enforced, not promised:
//
//   - **No reply carries a credential VALUE.** Tested by serialising whole
//     replies built from secret-bearing fixtures, on the success path and on
//     every failure path, for every provider-secret name this plugin knows.
//   - **Credential field NAMES go out deliberately** — the `credential_missing`
//     fixes must name `ANTHROPIC_AUTH_TOKEN` and the lane's own keys, because an
//     operator not told the vocabulary writes the wrong key into the right file
//     and gets the same silence. A name is not a secret; a value is.
//   - A failure is a CODE from a closed set with a sentence that is a constant
//     of this file. Raw exception text never reaches the wire — exporting
//     `String(error.message)` would ship whatever a future diagnostic
//     interpolates into it.
//
// ## "Valid configuration" does not mean the lane runs
//
// No endpoint is contacted, no credential accepted, no adapter resolved, no
// session negotiated. Reporting `ready: true` for that is measurably wrong: with
// no HOME, no PATH and no credentials the `claude` and `codex` lanes both
// reported ready. They answer `unchecked`, because for those two no parent-side
// check exists at all, and a diagnostic that says READY and then watches the
// real gate refuse is worse than none.
//
// ## ADR 0003 stands
//
// A DISPATCHED agent receives no MCP server, enforced at runtime and asserted by
// the suite. This server is the OPERATOR's surface. Nothing here adds an
// allowlist, profile field or companion branch that makes crossing that easier.
//
// ## Read-only, structurally
//
// Tools and handlers come from ONE descriptor list, so the advertisement and the
// dispatcher cannot disagree about which names exist. That is auditability in
// one place, not impossibility — a differently named hidden branch added later
// would still pass.

import { readFileSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

import { REVIEW_PROFILES, ROUTED_PROFILES, buildAcpLaunch, AGY_BINARY_NAME,
  AGY_BINARY_CANDIDATE_FORMS, acceptedCredentialNames, unresolvedInterpreterFor, acceptedRoutedKeys } from './review-profiles.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..', '..', '..')

// The version this server speaks. `initialize` answers with THIS, never with
// whatever the client asked for: echoing the request tells a client naming a
// version nobody implements that it got it.
export const PROTOCOL_VERSION = '2025-06-18'

// Read rather than restate. A version literal here would be an eighth place to
// bump, and the release flow already records that every previous one was found
// by a reader rather than by the flow.
function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const overrideNames = (id) => ({
  settings: `TMUX_TEAMS_REVIEW_${id.toUpperCase()}_SETTINGS`,
  credentials: `TMUX_TEAMS_REVIEW_${id.toUpperCase()}_ENV_FILE`,
})

// A closed set of outbound diagnostics. The raw exception is classified and
// then DROPPED; each sentence is a constant of this file and can therefore
// never contain anything a settings file put there.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const inner of Object.values(value)) deepFreeze(inner)
  return value
}

// The capability names MCP 2025-06-18 types. Anything else is a client
// extension and is not this server's to judge.
// `roots` ALONE. MCP 2025-06-18 types `listChanged` on that capability and
// leaves `sampling` and `elicitation` as open objects, so demanding a boolean
// from those refuses a conforming `sampling: { listChanged: "vendor-extension" }`.
// Read the schema for this list; three earlier versions were guesses at it.
// TWO axes, kept in two lists. MCP 2025-06-18 types four client capability
// members as objects and only `roots` types `listChanged` as a boolean —
// collapsing them means narrowing one axis silently narrows the other, and a
// test suite that only ever sends well-formed objects carrying odd VALUES will
// not notice.
const MCP_OBJECT_CAPABILITIES = Object.freeze(['roots', 'sampling', 'elicitation', 'experimental'])
const MCP_LISTCHANGED_CAPABILITIES = Object.freeze(['roots'])

export const DIAGNOSTICS = Object.freeze({
  endpoint_missing: 'the lane is pinned to an endpoint and this machine supplies no base URL for it',
  endpoint_mismatch: 'the base URL configured here is not the endpoint this lane is pinned to',
  credential_missing: 'the endpoint is configured but no provider credential was found for it',
  settings_unreadable: 'the settings this lane points at are not a readable JSON object',
  credential_unreadable: 'the credential file this lane points at exists but could not be read',
  executable_missing: 'an executable this lane needs was not found on this machine',
  profile_incomplete: 'this lane routes to a provider but its shipped profile declares no endpoint to pin',
  environment_unspawnable: 'the environment this lane would launch with cannot start a process',
  environment_over_budget: 'the environment this lane would launch with is larger than this gate allows',
  unclassified: 'the lane refused for a reason this server does not classify; run the gate for the detail',
  // Added for `acp_lane_probe` — three outcomes a LIVE attempt can learn that
  // `acp_lane_status` structurally cannot, because it contacts nothing. A code
  // is added here only once the transport can genuinely tell it apart from a
  // signal, never from provider text; anything that does not clear that bar
  // stays `unclassified`.
  quota_exhausted: 'the endpoint answered and reported no quota remaining for this credential',
  probe_timeout: 'the lane did not complete a trivial prompt within the probe timeout',
  // A live spawn failure the parent-side check can never see: EACCES/EPERM
  // means the resolved candidate EXISTS and this process is refused
  // permission to run it, which is a different repair from `executable_missing`
  // ("was not found") and a false one if told the same sentence — installing
  // or relocating a file that is already sitting right there fixes nothing.
  executable_unusable: 'an executable this lane needs was found but this process is not permitted to run it',
})

// Classification reads the exception and keeps only which BUCKET it fell into.
// Nothing derived from the message text survives this function.
// Matched against the SHAPE this system throws, not against loose text anywhere
// in the message. Every phrase below is one this module's own dependencies
// raise as `<lane> review <phrase>`, and the anchor stops a settings PATH
// containing the same words from selecting a diagnosis — otherwise a caller who
// controls a filename controls the classification.
const REVIEW_PHRASE = /(^|[\s:])review /

export function classify(message, { fileKind = null } = {}) {
  // `fileKind` is supplied by a caller that opened the file itself. It is the
  // only trustworthy source for which read failed; a path is caller-controlled
  // text and a message is not evidence of its own subject.
  if (fileKind === 'credential') return 'credential_unreadable'
  if (fileKind === 'settings') return 'settings_unreadable'
  const raw = String(message ?? '')
  // Ordinary filesystem failures were classified by nothing and fell through to
  // `unclassified`, which told an operator to run the gate for a detail the
  // gate would report as the same unreadable file.
  // Which FILE failed decides the repair: aiming every filesystem error at the
  // settings file sends the operator to edit the wrong file and variable.
  if (/\b(ENOENT|EACCES|EISDIR|ELOOP|EPERM)\b/.test(raw)) {
    // WHICH file failed is NOT knowable from the message. Searching the raw
    // text — which includes the PATH — for 'credential' or '.env' lets a caller
    // who controls a filename choose the diagnosis.
    //
    // The honest answer without call-site identity is the generic one. The
    // caller that KNOWS which file it opened passes `fileKind` and gets the
    // specific code; nothing guesses.
    return 'settings_unreadable'
  }
  const text = REVIEW_PHRASE.test(raw) ? raw.slice(raw.search(REVIEW_PHRASE)) : raw
  if (/requires ANTHROPIC_BASE_URL/.test(text)) return 'endpoint_missing'
  if (/endpoint must be|must be a valid URL/.test(text)) return 'endpoint_mismatch'
  if (/explicit provider credential/.test(text)) return 'credential_missing'
  // `pins no endpoint` is a PROFILE defect — this lane routes and declares no
  // endpoint to route to — and it used to be classified as unreadable SETTINGS.
  // A release panel called it a false diagnosis with non-repairing
  // instructions, and it was: the settings file is fine, the profile is not,
  // and telling an operator to fix their JSON sends them to a file that has
  // nothing wrong with it.
  if (/pins no endpoint/.test(text)) return 'profile_incomplete'
  if (/must be a JSON object/.test(text)) return 'settings_unreadable'
  // A JSON.parse failure arrives as V8's own wording and never mentions this
  // system at all, so the first version dropped ordinary malformed settings
  // into `unclassified` — safe on the wire and useless as a diagnosis.
  if (/JSON|Unexpected token|Unexpected end of/.test(text)) return 'settings_unreadable'
  // Its own bucket rather than `credential_*`: the value may be a credential
  // and may equally be a header, a model config or an oversized total, and
  // telling an operator to fix a credential is a false instruction in three of
  // those four cases.
  if (/cannot start a process/.test(text)) return 'environment_unspawnable'
  // A SEPARATE code, because the two sentences make different claims. "cannot
  // start" is a fact about the platform; "over budget" is a decision of ours,
  // and a lane measured this machine spawning an environment three times the
  // ceiling. One code for both would have kept saying the false half.
  if (/environment is over budget/.test(text)) return 'environment_over_budget'
  if (/executable not found/.test(text)) return 'executable_missing'
  return 'unclassified'
}

// The lanes for which NO parent-side configuration check exists. Naming them is
// the honest half: `buildProfileEnv` validates a routed endpoint and the AGY
// binary, and for these two it validates nothing, so a green answer from it
// would mean only "no check ran".
export const UNCHECKED_LANES = Object.freeze(['claude', 'codex'])

// Stated once and returned on every status answer, so a reader never has to
// infer the boundary from an adjective.
const NOT_PROVEN = Object.freeze([
  'that the endpoint can be reached',
  'that the credential is accepted by the provider',
  'that the adapter package resolves and starts',
  'that a session negotiates the requested model and mode',
])

// `acp_lane_probe` proves a strict superset of `NOT_PROVEN` and a strict
// subset of a real review — it is one trivial turn, once, right now. Stated
// on every probe answer for the same reason `NOT_PROVEN` is: a green answer
// that is silent about its own boundary is what `ready: true` cost this file
// once already.
const PROBE_NOT_PROVEN = Object.freeze([
  'that this lane stays reachable by the time a real review dispatches',
  'that the model answering is the model this lane declares',
  'that a review-sized brief succeeds the way this one-word probe did',
  'anything about quota remaining beyond this single call',
])

// A routed lane declares a WRAPPER as well as an adapter, and `buildProfileEnv`
// only writes its name into the child environment — resolution happens later,
// inside `acp-review-client`. Measured by an advisor: setting PATH to a path
// that does not exist left a routed lane answering `valid`. The adapter and the
// wrapper are separate fields in this very object, so a caveat naming only the
// adapter does not cover the wrapper. It is named.
function notProvenFor(profile) {
  if (!profile.claudeExecutable) return NOT_PROVEN
  return Object.freeze([...NOT_PROVEN,
    `that the wrapper \`${profile.claudeExecutable}\` exists on PATH`])
}

// What a lane DECLARES, which is knowable without touching this machine at all.
export function laneFacts(id, profile) {
  const endpoint = profile.endpoint
  const pinned = ROUTED_PROFILES.has(id) && endpoint?.host
  return {
    lane: id,
    family: profile.family ?? null,
    provider: profile.provider ?? null,
    model: profile.model ?? null,
    adapter: profile.adapterPackage ?? null,
    reviewMode: profile.reviewMode ?? null,
    routing: pinned ? `pinned:${endpoint.host}${endpoint.path ?? ''}` : 'unrouted',
    executable: profile.claudeExecutable ?? null,
  }
}

// Fixes keyed on the CAUSE. Ignoring `code` and emitting every generic setup
// sentence the profile allows tells `agy` — which fails for a missing binary —
// to repair the ADAPTER PACKAGE: worse than an unclassified answer, because it
// sounds specific. Non-empty was never the property worth asserting; naming the
// thing that actually refused is.
function settingsFixes(id, profile) {
  const names = overrideNames(id)
  if (!profile.settingsRelativePath) return []
  return [
    `place this lane's settings JSON at $HOME/${profile.settingsRelativePath}`,
    `or point ${names.settings} at wherever this machine keeps it`,
  ]
}

function executableFixes(id, profile) {
  const out = []
  if (id === 'agy') {
    // The UNRESOLVED forms. Interpolating the resolved candidate put whatever
    // `HOME` happened to contain on the wire, and an advisor demonstrated a
    // credential escaping that way while every credential FIELD stayed clean.
    // Nothing in this sentence now comes from the environment.
    out.push(`a trusted, EXECUTABLE \`${AGY_BINARY_NAME}\` must exist at one of: `
      + AGY_BINARY_CANDIDATE_FORMS.join(', ')
      + ' — a file that merely exists is not enough, it must be a regular file with the execute bit')
  }
  if (profile.claudeExecutable) {
    out.push(`the wrapper \`${profile.claudeExecutable}\` must exist on PATH and select this provider`)
  }
  if (Array.isArray(profile.command) && profile.command.length) {
    out.push(`the adapter this lane launches (\`${profile.command.join(' ')}\`) must resolve`)
  }
  return out
}

// Naming the keys that are actually accepted, because "point it at the env file
// holding the credential" was true of the variable and false of the file: the
// env-file loader dropped `ZAI_API_KEY` while the endpoint validator accepted
// it ambient, so the prescribed repair left the lane refusing exactly as
// before. The loader is fixed; the sentence now says which names work so a
// reader is never left guessing at the vocabulary.
function credentialFixes(id) {
  if (!ROUTED_PROFILES.has(id)) return []
  const names = overrideNames(id)
  // The SAME function the validator calls, never a second list that agrees with
  // it today — a hand-built copy drifts within a release and advertises names
  // the validator will not accept, which is a fix that cannot repair its own
  // refusal.
  const accepted = acceptedCredentialNames(REVIEW_PROFILES[id])
  return [
    `if the credential lives outside that JSON, point ${names.credentials} at the env file holding it`,
    // The FULL set the loader honours, not the credential subset. This named
    // `acceptedCredentialNames` and then said every other name is ignored,
    // which was false by the routed settings names — an operator who put
    // ANTHROPIC_BASE_URL in that file was told it would be ignored while the
    // loader read it.
    `that file is read for ${[...acceptedRoutedKeys(REVIEW_PROFILES[id])].sort().join(', ')} `
      + '— any other name in it is ignored',
  ]
}

export function fixesFor(id, profile, code, { envKey = null } = {}) {
  const names = overrideNames(id)
  const settings = settingsFixes(id, profile)
  switch (code) {
    case 'endpoint_missing':
    case 'endpoint_mismatch':
      return settings.length ? settings
        : [`this lane's base URL must come from ${names.settings} or ${names.credentials}`]
    case 'credential_missing':
      return [...credentialFixes(id), ...settings]
    case 'environment_unspawnable':
      // NAMES THE VALUE. The first version said "the refusal names which" while
      // this boundary deliberately drops the raw exception, so it named nothing
      // — and then pointed at the settings file, which a lane showed loses to
      // the later ambient assignment for the very key that failed. The key
      // travels on the error the same way `fileKind` does.
      return [envKey
        ? `${envKey} contains a NUL byte and cannot be passed to a process — `
          + `clear it wherever it is set for this lane, which may be the ambient `
          + `environment rather than ${overrideNames(id).settings}`
        : 'one of the values this lane forwards contains a NUL byte and cannot be '
          + 'passed to a process']
    case 'environment_over_budget':
      // NO "point it at a credential file". That was the second half of this
      // sentence and it does not repair anything: `loadRoutedCredentialFile`
      // reads the file and puts the same bytes into the child environment,
      // where the same ceiling refuses them. A lane applied the advice and
      // measured an identical refusal — which is the test this repository's own
      // diagnostic contract asks for, that applying a fix changes the state.
      return [envKey
        ? `${envKey} is larger than this gate passes to a lane — it has to be `
          + `SHORTER, and moving it to a credential file does not help because `
          + `the file's contents reach the lane the same way`
        : 'the values this lane forwards exceed the total this gate passes to a lane']
    case 'settings_unreadable':
      return ['the JSON this lane reads must parse and must be an object', ...settings]
    case 'credential_unreadable':
      // Deliberately does NOT point at the settings file. Aiming every
      // filesystem failure at the settings repair is the defect this code was
      // added for: it sent the operator to edit a file that was fine.
      return ['the credential file exists but could not be read — check that it is '
        + 'readable by this user, and that its mode is 0600 rather than a directory or a dangling link',
      ...credentialFixes(id)]
    case 'profile_incomplete':
      // Nothing an operator can repair on their own machine: the profile ships
      // with the plugin. Saying so is the honest answer.
      return ['this is a defect in the shipped profile, not in your configuration — '
        + 'the lane declares routing with no endpoint, and only a plugin change can fix it']
    case 'executable_missing':
      return executableFixes(id, profile)
    default:
      return [...settings, ...credentialFixes(id), ...executableFixes(id, profile)]
  }
}

// Configuration validity, and never a claim beyond it.
export function laneStatus(id, profile, env) {
  const facts = laneFacts(id, profile)
  if (UNCHECKED_LANES.includes(id)) {
    return {
      ...facts,
      configuration: 'unchecked',
      problem: null,
      fixes: fixesFor(id, profile, null),
      notProven: notProvenFor(profile),
      note: 'no parent-side configuration check exists for this lane, so nothing here was verified',
    }
  }
  try {
    // The object this returns CONTAINS the credential. It is bound to nothing
    // and referenced nowhere, which is the whole of what "never returned" means.
    buildAcpLaunch(id, { env })
    // `valid` means every parent-side check PASSED — not that some of them
    // could not be run. A candidate whose shebang names an interpreter that is
    // not on this machine passes `executableCandidate` (the kernel would accept
    // the file and then fail to find the interpreter), so the lane used to
    // answer `valid` for a configuration that cannot start. Two panel families
    // raised it across two rounds.
    //
    // `unchecked` is what that state is, it is already in the vocabulary, and
    // reaching it costs one 256-byte read — not the execution the old defence
    // said it would require.
    const unresolved = unresolvedInterpreterFor(id, { env })
    if (unresolved) {
      return {
        ...facts,
        configuration: 'unchecked',
        problem: null,
        fixes: [`the executable this lane resolves to begins \`#!\` naming an interpreter `
          + `that is not on this machine — install it, or point the lane at a binary that needs none`],
        notProven: notProvenFor(profile),
        note: 'the configuration is complete, and the executable it resolves to cannot start here',
      }
    }
    return { ...facts, configuration: 'valid', problem: null, fixes: [], notProven: notProvenFor(profile) }
  } catch (error) {
    // `error.fileKind` when the thrower knew which file it was opening. A pure
    // function tested in isolation says nothing about its consumer — CLAUDE.md's
    // own rule, and this line broke it: `classify` grew a `fileKind` parameter,
    // the test called it directly, and NOTHING ever passed one, so the new
    // diagnostic was dead on every path a caller can reach.
    const code = classify(error?.message, { fileKind: error?.fileKind ?? null })
    return {
      ...facts,
      configuration: 'invalid',
      problem: { code, detail: DIAGNOSTICS[code] },
      fixes: fixesFor(id, profile, code, { envKey: error?.envKey ?? null }),
      notProven: notProvenFor(profile),
    }
  }
}

// ## `acp_lane_probe` — the one tool in this file that contacts an endpoint
//
// Everything above this line answers from declared facts or local files.
// This section spawns a real process and speaks the minimum of ACP needed to
// learn whether the OTHER end answers, is out of quota, or refuses for some
// other reason — classified into a SIGNAL shape, never into text, so the
// classifier below never sees a provider's own words.

// A per-lane ceiling, not a suggestion. A probe that never returns is a probe
// that was not cheap, and "cheap" is the entire justification for shipping
// this at all.
export const PROBE_TIMEOUT_MS = 20_000

// Deliberately not a question the model can answer at length. One word bounds
// the reply this tool has to wait for and keeps every probe the same size.
export const PROBE_BRIEF = 'Reply with exactly one word: ok.'

// Printed only when the promise this tool returns rejects anyway. Every
// EXPECTED failure — including a transport that rejects instead of resolving
// a signal — is caught inside `probeOneLane` and turned into a classified,
// per-lane `unclassified` result, so a bad lane never scraps the lanes probed
// before it in the same call. This sentence is therefore a backstop against a
// bug THIS file has, not an expected outcome. A rejected handler promise
// reaching `serve()` with nothing to catch it is the EPIPE shape this project
// has already lost a whole gate to.
const PROBE_CRASHED = 'the probe crashed before producing a classified result'

// The transport's contract is a closed SIGNAL shape, never text:
//   { settled: 'response' }                    a session/prompt result arrived
//   { settled: 'timeout' }                      nothing arrived inside PROBE_TIMEOUT_MS
//   { settled: 'spawn_error', errnoCode }        the process itself never started
//   { settled: 'exit', code, quotaSignal }       the process exited before finishing the turn;
//                                                 quotaSignal is a boolean the TRANSPORT decided,
//                                                 never the bytes that decided it
//   { settled: 'refused', quotaSignal }          session/prompt came back a JSON-RPC error and the
//                                                 process did NOT exit — no 'exit' event is coming,
//                                                 so this is the only place left that can still see
//                                                 whatever quotaSignal was already true by then
//   { settled: 'invalid_handshake' }             session/new succeeded with no sessionId
//   { settled: 'cancelled' }                     session/prompt completed carrying
//                                                 stopReason: 'cancelled' — a round trip, not an answer
// `classifyProbe` reads only this shape. It is exported and pure so a test
// can drive every branch with a plain object and never a subprocess.
// The companion's own session-id shape, copied with its source named. This file
// imports no sibling script on purpose, so the drift answer is a test that
// asserts the two stay identical rather than a coupling.
const PROBE_SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/

export function classifyProbe(result) {
  if (!result || typeof result !== 'object') return 'unclassified'
  if (result.settled === 'response') return null
  if (result.settled === 'timeout') return 'probe_timeout'
  if (result.settled === 'spawn_error') {
    // ENOENT is "not found"; EACCES/EPERM is "found, and this process may not
    // run it" — a permissions problem, not a missing binary. Collapsing both
    // onto one code sent an operator to install or relocate a file that was
    // already sitting right there.
    return result.errnoCode === 'EACCES' || result.errnoCode === 'EPERM'
      ? 'executable_unusable' : 'executable_missing'
  }
  if (result.settled === 'exit' && result.quotaSignal === true) return 'quota_exhausted'
  if (result.settled === 'refused') return result.quotaSignal === true ? 'quota_exhausted' : 'unclassified'
  // These two return what the default below returns, and deleting this line
  // leaves the suite at 69/0 — measured, so it is written down rather than
  // presented as a guard. It is a PIN, not a decision: it fixes the answer for
  // two shapes this release introduced, so that changing the catch-all cannot
  // silently reclassify a cancelled turn or a handshake with no session as
  // something a caller would act on.
  if (result.settled === 'invalid_handshake' || result.settled === 'cancelled') return 'unclassified'
  return 'unclassified'
}

// The REAL transport. Nothing in this file's own suite drives it — the seam
// below (`deps.probeTransport`) is what every test exercises instead, on
// purpose, per the roadmap's own warning that a real probe spends real
// minutes and real provider quota. Treat this function as unverified against
// a live provider by this change's own tests, the same honesty this repo
// already applies to `party-advise`'s bwrap gate: designed carefully, proven
// only by a real run nobody has yet spent the quota to take.
// EXPORTED so it can be exercised against a stub ACP agent. It was the one
// piece of this feature nothing ran: every test injected a fake through
// `deps.probeTransport`, which proves the classifier and proves nothing about
// the code that actually spawns an adapter and reads its frames. The quota
// pattern below is the sharpest example — if it misses a provider's real
// wording, an exhausted lane reports `unclassified` and a fake transport can
// never tell you.
// `spawnFn` is a seam, defaulted to the real `spawn` so production has no
// branch. It exists because the stream-level 'error' listeners below cannot be
// reached any other way: a read fault on a pipe is not something a test can
// schedule, and the first attempt at that test passed `spawnFn` to a function
// that did not take it — so nothing was injected and it went green while the
// listeners were deleted.
export async function realProbeTransport({ command, env, timeoutMs, spawnFn = spawn }) {
  return new Promise((settle) => {
    let done = false
    let child
    let killTimer = null
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      // `pid` unset means the process never actually forked (a synchronous
      // spawn() throw, or an async 'error' before any pid was assigned) — no
      // 'exit' event is guaranteed for that shape on every platform, and
      // waiting for one would trade a fast, correct classification for a
      // probe that never settles. A child that DID fork is signalled and this
      // promise now waits for its REAL 'exit' before resolving: settling on
      // SIGTERM/SIGKILL alone let `probeLanes`'s own sequential loop start the
      // NEXT lane's spawn while this one was still tearing down through the
      // kill grace window, contradicting the one-budget-at-a-time comment
      // above `probeLanes`.
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        // Clear the escalation on the way out. Without this the timer outlives
        // settlement: a stub probe that answered in ~70ms held the node process
        // alive for the full 2s and then tried to SIGKILL a child that had been
        // dead the whole time. Bounded, so not a leak — but latency nobody
        // chose, on the one path a caller runs once per lane.
        child.once('exit', () => { if (killTimer) clearTimeout(killTimer); settle(result) })
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 2000)
        killTimer.unref?.()
        return
      }
      settle(result)
    }
    const timer = setTimeout(() => finish({ settled: 'timeout' }), timeoutMs)

    const [bin, ...args] = command
    try {
      child = spawnFn(bin, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      clearTimeout(timer)
      finish({ settled: 'spawn_error', errnoCode: error?.code ?? null })
      return
    }
    let spawnFailed = false
    child.once('error', (error) => {
      spawnFailed = true
      finish({ settled: 'spawn_error', errnoCode: error?.code ?? null })
    })
    // A child that closes fd 0 at the OS level while staying alive (a
    // non-Node adapter closing its input pipe, or exiting its read loop
    // without exiting the process) delivers the parent's NEXT
    // `child.stdin.write()` as an async 'error' event — measured directly:
    // `write()` itself returns `false` with no throw, so the try/catch inside
    // `send()`/`replyToChild()` below is a no-op, and the event fires after
    // the call already returned. Swallowing here is correct, not a shortcut:
    // the child's own `exit`/`error` handlers above already carry what
    // happened; this listener only stops the write-side echo of that same
    // event from becoming an unhandled one that kills the whole server.
    child.stdin.on('error', () => {})

    // A provider's own wording never leaves this function — this boolean is
    // the ONLY thing either stream is allowed to produce for the caller.
    let quotaSignal = false
    const QUOTA_SIGNAL = /\b(quota|rate.?limit(?:ed)?|429|insufficient_quota|resource_exhausted)\b/i
    // Measured, not theoretical: two ordinary back-to-back writes of one word
    // split across the write boundary ('resource_' then 'exhausted') arrived
    // as two SEPARATE 'data' events in the majority of trials, and neither
    // half alone matches. Testing each chunk in isolation misses the signal
    // at a high rate. Carry a bounded TAIL of the previous chunk into the next
    // test instead — the same reason the JSON-RPC line parser below
    // accumulates into `buf` rather than trusting chunk boundaries. The cap is
    // bytes, not lines: an agent that never stops talking must not grow this
    // without bound, and every word this regex matches is under 20 bytes, so a
    // tail many times that length still catches a split across any boundary.
    // Code units, not bytes. The quota tokens this watches for are ASCII, so a
    // 64-unit tail always spans them; the name says CAP rather than BYTES for
    // that reason, and ADR 0007 says 'characters' where it once said 'bytes'.
    const QUOTA_TAIL_CAP = 64
    const makeQuotaWatcher = () => {
      let tail = ''
      return (chunk) => {
        const text = tail + String(chunk)
        if (QUOTA_SIGNAL.test(text)) quotaSignal = true
        tail = text.slice(-QUOTA_TAIL_CAP)
      }
    }
    // One watcher per stream: stderr and stdout arrive on independent OS
    // pipes, so a tail built from one must never be tested against a chunk
    // from the other.
    const noteStderrQuotaSignal = makeQuotaWatcher()
    const noteStdoutQuotaSignal = makeQuotaWatcher()
    // A stdio Socket emits its OWN 'error'; `child.on('error')` is the ChildProcess
    // and does not cover it, so an unhandled read fault here takes the whole process
    // down. Found on the third pass: two doors were named, a survey of every stream
    // with a 'data' listener and no 'error' listener found seven.
    child.stderr.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('data', noteStderrQuotaSignal)

    // One JSON-RPC line at a time, id-correlated, exactly the framing this
    // server itself speaks on its own stdio — the difference is this side is
    // the CLIENT now.
    let buf = ''
    let outBytes = 0
    // A generous multiple of a one-word answer, not a real turn's budget: an
    // adapter emits one envelope per streamed token, and this project has
    // already measured that amplify past 2MB on an ordinary answer.
    const OUT_CAP = 2_000_000
    let nextId = 1
    const pending = new Map()
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
    const replyToChild = (id, result) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`) } catch { /* child is gone */ }
    }

    child.stdout.on('data', (chunk) => {
      noteStdoutQuotaSignal(chunk)
      outBytes += chunk.length
      if (outBytes > OUT_CAP) return
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (!message || typeof message !== 'object') continue
        if ('id' in message && !('method' in message)) {
          const entry = pending.get(message.id)
          if (!entry) continue
          pending.delete(message.id)
          if (message.error) entry.reject(new Error('probe request refused'))
          else entry.resolve(message.result)
        } else if ('id' in message && 'method' in message) {
          // A child-initiated request. NEVER granted — a probe proves
          // reachability, it authorizes nothing. Answering immediately also
          // keeps a spec-conforming child from stalling us to the timeout
          // waiting on a reply that was never coming.
          replyToChild(message.id, message.method === 'session/request_permission'
            ? { outcome: { outcome: 'cancelled' } }
            : {})
        }
        // A notification (no `id`) is ignored — this probe classifies the
        // final outcome, not the stream of progress in between.
      }
    })

    child.once('exit', (code) => {
      if (spawnFailed) return
      finish({ settled: 'exit', code, quotaSignal })
    })

    ;(async () => {
      try {
        await send('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'tmux-teams-acp-lane-probe', version: pluginVersion() },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })
        const session = await send('session/new', { cwd: tmpdir(), mcpServers: [] })
        // A well-formed success can still omit `sessionId` — nothing upstream
        // validates the shape of a session/new result. Returning with nothing
        // settled here left only the 20s timeout to close this out, reporting
        // a lane that answered an invalid handshake immediately as one that
        // never answered at all.
        // TYPE, not truthiness. `sessionId: {}` is truthy, so the first version of
        // this guard let a malformed handshake through and the lane was reported
        // `reachable` — an actionable lie from the one tool whose entire job is
        // classifying reachability. The shape is the companion's own
        // `SESSION_ID_RE`, named here rather than imported because this file
        // deliberately depends on no sibling script.
        // `typeof` FIRST: `RegExp.test` coerces, so the regex alone accepts 42 and
        // true — measured while writing this, one fix after the same mistake.
        if (typeof session?.sessionId !== 'string' || !PROBE_SESSION_ID_RE.test(session.sessionId)) {
          finish({ settled: 'invalid_handshake' }); return
        }
        const result = await send('session/prompt',
          { sessionId: session.sessionId, prompt: [{ type: 'text', text: PROBE_BRIEF }] })
        // `stopReason: 'cancelled'` is what comes back when the turn itself
        // was cut short — including by our OWN `replyToChild` above, which
        // never grants a permission request. The round trip completed, but no
        // answer was produced, which is not the claim `settled: 'response'`
        // makes: treating any non-error result as reachable let a cancelled
        // turn report the same as a real one.
        finish({ settled: result?.stopReason === 'cancelled' ? 'cancelled' : 'response' })
      } catch {
        // A rejected request means the child refused (auth, quota, malformed
        // reply) WITHOUT exiting — the `exit` handler above cannot help here
        // because the process is still alive, so the 20s timeout used to be
        // the only thing that settled this, discarding an already-true
        // quotaSignal for the entire wait and reporting the wrong code after
        // the longest possible delay. Settle now with whatever this call
        // already knows.
        finish({ settled: 'refused', quotaSignal })
      }
    })()
  })
}

// All shape enforcement for `acp_lane_probe` lives HERE, not in
// `argumentsProblem` — that checker only types declared STRING properties
// and does not read `required`, so `lanes` missing, empty, a bare string, or
// carrying a non-string entry all pass the envelope check untouched. This
// function is therefore the entire anti-sweep guard: every branch below
// returns before a single process is spawned, and the ONLY way past it is a
// non-empty array of ids this plugin already declares.
function probeArgsProblem(args) {
  const lanes = args?.lanes
  if (!Array.isArray(lanes) || lanes.length === 0) {
    return 'lanes is required and must be a non-empty array of lane ids — there is no probe-everything default'
  }
  if (!lanes.every((entry) => typeof entry === 'string')) {
    return 'every entry in lanes must be a string lane id'
  }
  return null
}

async function probeOneLane(id, profile, env, transport) {
  const status = laneStatus(id, profile, env)
  // Already known broken, and known WHY — a live attempt would learn nothing
  // a spawn cannot already answer, and would spend a process on a lane that
  // cannot start. `acp_lane_status`'s own diagnostic is the honest answer.
  if (status.configuration === 'invalid') {
    return {
      lane: id,
      probe: 'not_attempted',
      configuration: 'invalid',
      problem: status.problem,
      fixes: status.fixes,
      notProven: PROBE_NOT_PROVEN,
    }
  }
  let launch
  try {
    launch = buildAcpLaunch(id, { env })
  } catch (error) {
    const code = classify(error?.message, { fileKind: error?.fileKind ?? null })
    return {
      lane: id,
      probe: 'unreachable',
      configuration: status.configuration,
      problem: { code, detail: DIAGNOSTICS[code] },
      fixes: fixesFor(id, profile, code, { envKey: error?.envKey ?? null }),
      notProven: PROBE_NOT_PROVEN,
    }
  }
  // A REJECTING transport is caught HERE, per lane, on purpose. Left
  // unguarded, one misbehaving lane would reject the whole `probeLanes`
  // promise and scrap every other lane already probed sequentially before
  // it in the same call — and whatever the rejection carries, which may be a
  // raw provider message, must never propagate any further than this catch.
  // `classifyProbe(null)` already answers `unclassified`, so a rejection
  // lands in the same honest bucket a malformed signal would.
  let result
  try {
    result = await transport({
      id, command: launch.command, env: launch.env, timeoutMs: PROBE_TIMEOUT_MS,
    })
  } catch {
    result = null
  }
  const code = classifyProbe(result)
  if (!code) {
    return { lane: id, probe: 'reachable', configuration: status.configuration, problem: null, notProven: PROBE_NOT_PROVEN }
  }
  return {
    lane: id,
    probe: 'unreachable',
    configuration: status.configuration,
    problem: { code, detail: DIAGNOSTICS[code] },
    fixes: (code === 'executable_missing' || code === 'executable_unusable')
      ? executableFixes(id, profile) : [],
    notProven: PROBE_NOT_PROVEN,
  }
}

// The anti-sweep guard AND the dedup guard live before the loop: a caller who
// repeats a lane id must not spend that lane's quota twice for one call.
async function probeLanes(args, env, transport) {
  const problem = probeArgsProblem(args)
  if (problem) return { error: problem, known: Object.keys(REVIEW_PROFILES) }
  const ids = [...new Set(args.lanes)]
  if (ids.some((id) => !Object.hasOwn(REVIEW_PROFILES, id))) {
    return { error: 'no such lane', known: Object.keys(REVIEW_PROFILES) }
  }
  // Sequential, never Promise.all — a live probe spends real quota and real
  // minutes, and running lanes concurrently would spend several budgets at
  // once for a caller who typed one call.
  const lanes = []
  for (const id of ids) {
    lanes.push(await probeOneLane(id, REVIEW_PROFILES[id], env, transport))
  }
  return { lanes }
}

// ONE list. `TOOLS` and the dispatcher are both derived from it, so an
// unadvertised handler is not something a reviewer has to go looking for — it
// is unrepresentable.
// `Object.freeze` on an array freezes the ARRAY, not the records inside it, so
// both of these stayed writable by an in-process importer while ADR 0007 called
// the one-descriptor-list invariant not representable as drift. A panel lane
// read the claim against the two calls. `deepFreeze` makes the claim true for
// what it covers; it still cannot stop a differently named handler being added
// later, which the ADR already says.
export const TOOL_DESCRIPTORS = deepFreeze([
  {
    name: 'acp_lanes',
    description: 'List every ACP review lane this plugin declares: family, provider, model, '
      + 'adapter package, and whether the lane DECLARES a pinned endpoint. Declared facts only '
      + '- it touches nothing on this machine and answers with no configuration present.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({ lanes: Object.entries(REVIEW_PROFILES).map(([id, p]) => laneFacts(id, p)) }),
  },
  {
    name: 'acp_lane_status',
    description: 'Report whether a lane\'s CONFIGURATION is valid on this machine, and when it is not, '
      + 'which closed diagnostic applies and which environment variable points at the missing piece. '
      + 'It reads settings and credential files to decide, and never returns a credential or a '
      + 'credential value. It does not prove the lane runs: no endpoint is contacted and no session '
      + 'is started. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'One lane id. Omit to report every lane.' },
      },
      additionalProperties: false,
    },
    handler: (args, env) => {
      const wanted = args?.lane
      if (wanted !== undefined && !Object.hasOwn(REVIEW_PROFILES, wanted)) {
        // The `known` list already carries the vocabulary, so echoing what the
        // caller sent adds nothing and contradicts this file's own stated
        // invariant that every sentence it emits is a constant. Two panel
        // lanes raised it independently.
        return { error: 'no such lane', known: Object.keys(REVIEW_PROFILES) }
      }
      const ids = wanted === undefined ? Object.keys(REVIEW_PROFILES) : [wanted]
      return { lanes: ids.map((id) => laneStatus(id, REVIEW_PROFILES[id], env)) }
    },
  },
  {
    name: 'acp_lane_probe',
    description: 'Contact named ACP lanes LIVE, one trivial one-word brief each, and report each as '
      + 'reachable, out of quota, or refused — classified into a closed code, never the provider\'s own '
      + 'wording. This is the one tool on this server that contacts an endpoint: it spends real minutes '
      + 'and real provider quota, bounded by a per-lane timeout. `lanes` is REQUIRED and must be a '
      + 'non-empty array of lane ids named explicitly — there is no probe-everything default, so a sweep '
      + 'has to be typed on purpose every time. A lane whose configuration is already invalid is reported '
      + 'from that diagnosis without being contacted. This starts no review and no delivery work: one '
      + 'process per named lane, asked one word, torn down.',
    inputSchema: {
      type: 'object',
      properties: {
        lanes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lane ids to probe live, named explicitly. Required and non-empty — omitting it '
            + 'or sending an empty array is refused rather than defaulting to every lane.',
        },
      },
      required: ['lanes'],
      additionalProperties: false,
    },
    // `deps.probeTransport` is the seam every test in this file's suite
    // drives instead of a subprocess. The real transport runs only when
    // nothing injects one — i.e. only from the manifest-launched server.
    handler: (args, env, deps = {}) => probeLanes(args, env, deps.probeTransport ?? realProbeTransport),
  },
])

export const TOOLS = deepFreeze(TOOL_DESCRIPTORS.map(({ handler, ...rest }) => rest))
const HANDLERS = new Map(TOOL_DESCRIPTORS.map((d) => [d.name, d.handler]))

export function callTool(name, args, env, deps) {
  const handler = HANDLERS.get(name)
  if (!handler) return { error: 'no such tool', known: [...HANDLERS.keys()] }
  return handler(args, env, deps)
}

// ## Validation, and why there was none
//
// The first three versions of this file validated nothing about the envelope.
// A Codex advisor drove the real stdio server with hand-built frames and got a
// successful tool list out of `"jsonrpc":"1.0"`, successful content out of
// `arguments: []` against an object-only schema, an unknown tool reported as a
// SUCCESSFUL result carrying `isError`, and silence for an `id: null` request.
// Every one of those contradicts MCP 2025-06-18 and JSON-RPC 2.0, and a
// permissive host continuing anyway is not a conformance check — it is the
// reason nobody noticed. Middleware that cannot tell protocol misuse from tool
// failure is the concrete cost.
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_PARSE_ERROR = -32700

// Each reason is a constant sentence, for the same reason every diagnostic in
// this file is: nothing a caller sent may be echoed back out.
export const REQUEST_PROBLEMS = Object.freeze({
  batch: 'JSON-RPC batching is not supported by MCP 2025-06-18',
  not_an_object: 'a request must be a JSON object',
  jsonrpc: 'a request must carry jsonrpc "2.0"',
  method: 'a request must carry a string method',
  id: 'a request id must be a string or a finite number, and must not be null',
})

// Structure only. `null` means the frame is a legal request or a legal
// notification; the caller decides which by whether an `id` member is present.
export function requestProblem(message) {
  if (Array.isArray(message)) return 'batch'
  if (message === null || typeof message !== 'object') return 'not_an_object'
  if (message.jsonrpc !== '2.0') return 'jsonrpc'
  if (typeof message.method !== 'string') return 'method'
  if ('id' in message) {
    const { id } = message
    // `id: null` is reserved for a response that could not determine one. As a
    // REQUEST id it is invalid, and treating it as "no id" is what made the
    // server drop such a frame in silence.
    //
    // Any NUMBER, not any integer. The first version demanded `Number.isInteger`
    // and a Codex advisor caught it turning a SHOULD NOT into a MUST NOT:
    // JSON-RPC 2.0 says fractional ids should not be used and MCP's `RequestId`
    // is `string | number`, so `id: 1.5` is a legal request that this server was
    // refusing — and refusing in the one way that loses the correlation, under
    // `id: null`. Being stricter than the spec is not the safe direction when
    // the cost is dropping legitimate traffic.
    if (!(typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)))) return 'id'
  }
  return null
}

// Per-method params, because an envelope check is not a params check: validate
// `tools/call` alone and `initialize` with no params, `tools/list` with
// `params: []` and `ping` with unexpected params all answer SUCCESS.
//
// `initialize` requires everything MCP 2025-06-18 requires — `protocolVersion`,
// `capabilities` and `clientInfo`. Being tolerant here was argued for and
// reversed: the tolerance protects a case nobody has observed, while the
// `2025-06-18` advertisement is made on every single initialize.
// Every method this server answers. Pinned as a set rather than inferred from
// the if-chain below, so a method that gains params validation and a method
// that gains a handler cannot drift apart.
export const KNOWN_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call'])

export function paramsProblem(method, params) {
  const isObject = params === undefined
    || (params !== null && typeof params === 'object' && !Array.isArray(params))
  if (!isObject) return `${method} params must be an object`
  if (method === 'initialize') {
    if (params === undefined) return 'initialize requires params'
    if (typeof params.protocolVersion !== 'string') return 'initialize requires a string protocolVersion'
    for (const key of ['capabilities', 'clientInfo']) {
      const value = params[key]
      if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
        return `initialize requires an object ${key}`
      }
    }
    // `clientInfo` is an Implementation: it requires `name` and `version`.
    // Requiring the OBJECT and not its contents is half a rule, and two panel
    // lanes said so — the file claims the check "matches the version this
    // server claims to speak", and it did not.
    for (const key of ['name', 'version']) {
      if (typeof params.clientInfo[key] !== 'string') return `initialize clientInfo requires a string ${key}`
    }
    // `title` is OPTIONAL and typed as a string when present. A lane reproduced
    // `clientInfo: { name, version, title: 42 }` returning success from a
    // validator that claims to match this protocol version.
    if (params.clientInfo.title !== undefined && typeof params.clientInfo.title !== 'string') {
      return 'initialize clientInfo title must be a string'
    }
    // The known capability members are typed too — `roots.listChanged` and
    // `sampling`/`elicitation` shapes. Same lane, same frame:
    // `capabilities: { roots: { listChanged: "yes" } }` was accepted. Only the
    // members MCP names are checked; an unknown capability is a client
    // extension and stays legal, which is the difference between validating a
    // protocol and refusing a future one.
    // KNOWN members only, and NO caller text in the sentence. The previous
    // version failed both ways at once, and a lane reproduced each: it demanded
    // a boolean `listChanged` from EVERY capability name — so a legal
    // `experimental` map carrying a `listChanged` of another shape was refused,
    // turning a validator into a ceiling on a protocol that says extensions
    // stay legal — and it interpolated the caller's capability NAME into the
    // reply, which is the constant-sentence invariant this module states about
    // itself, broken inside the check written to enforce a different one.
    for (const name of MCP_OBJECT_CAPABILITIES) {
      const member = params.capabilities[name]
      if (member === undefined) continue
      if (member === null || typeof member !== 'object' || Array.isArray(member)) {
        return 'initialize capabilities members must be objects'
      }
    }
    // `experimental` is `{ [key: string]: object }` — the VALUES are typed too,
    // and checking only the outer object accepted `{"vendor": true}` from a
    // live client. Found by driving the running server, not by reading: the
    // outer-shape fix landed and read as complete, because the four names in
    // the list above are the right four and nothing said the map had a second
    // rule inside it.
    if (params.capabilities.experimental !== undefined) {
      for (const value of Object.values(params.capabilities.experimental)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return 'initialize capabilities experimental values must be objects'
        }
      }
    }
    for (const name of MCP_LISTCHANGED_CAPABILITIES) {
      const member = params.capabilities[name]
      if (member?.listChanged !== undefined && typeof member.listChanged !== 'boolean') {
        return 'initialize capabilities listChanged must be a boolean'
      }
    }
  }
  if (method === 'tools/list' && params?.cursor !== undefined && typeof params.cursor !== 'string') {
    return 'tools/list cursor must be a string'
  }
  // `ping` takes no params. The header comment said round four had reproduced
  // `ping` with unexpected params answering SUCCESS and that it was fixed; a
  // panel lane read the code and found nothing validating ping at all. The
  // comment described a fix that was never written — worse than no comment,
  // because it tells a reader to stop looking.
  // `_meta` is legal on ANY request in MCP 2025-06-18, so "ping takes no params"
  // rejected conforming traffic. Two commits after being told that tolerance was
  // wrong, I was told strictness was — and both were right, because the line is
  // the spec rather than a preference in either direction.
  // `_meta` is legal on any request AND is typed as an object. Accepting it as
  // any value was the overcorrection: one commit stopped refusing legal traffic
  // and started accepting illegal traffic, and the same panel family caught
  // both halves.
  if (params !== undefined && params._meta !== undefined
    && (typeof params._meta !== 'object' || params._meta === null || Array.isArray(params._meta))) {
    return '_meta must be an object'
  }
  // `PingRequest.params` is an OPEN object in MCP 2025-06-18 — `_meta` plus
  // arbitrary keys — so rejecting unknown keys refused conforming traffic
  // (`{traceContext: {}}` is the reviewer's own reproduction). This line has
  // now been wrong in both directions and the lesson is the same each time:
  // the answer is the specification, and a preference for strictness is not a
  // reading of it. `_meta`'s TYPE is still checked above, because the spec
  // types that one.
  return null
}

// A deliberately small schema check, matching only what the descriptors
// declare: an object with typed, optional properties and no others. It is not a
// JSON Schema implementation and must not grow into one — a descriptor that
// needs more than this should be simplified instead.
export function argumentsProblem(schema, args) {
  if (args === undefined) return null
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object'
  // The names come from the DESCRIPTOR, never from the caller. Echoing the
  // offending key back would be harmless to its sender and would still break
  // the property this file is easiest to check against: every sentence it emits
  // is a constant of the module.
  const declaredNames = Object.keys(schema?.properties ?? {})
  const allowed = declaredNames.length ? declaredNames.join(', ') : '(this tool takes no arguments)'
  for (const [key, value] of Object.entries(args)) {
    // `Object.hasOwn`, not a truthiness test on a lookup. `properties` is a
    // plain object literal, so `properties['constructor']` resolves up the
    // prototype chain and returns a function — which the old check read as "yes,
    // that argument is declared". A panel lane found it: `additionalProperties:
    // false` was bypassable by naming anything on Object.prototype.
    const declared = Object.hasOwn(schema?.properties ?? {}, key) ? schema.properties[key] : undefined
    if (!declared) return `arguments may contain only: ${allowed}`
    // Safe to name: this branch is reached only when `key` matched a declared
    // property, so the string is the descriptor's, not the caller's.
    if (declared.type === 'string' && typeof value !== 'string') return `argument ${key} must be a string`
  }
  return null
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export function handle(message, env = process.env, deps) {
  const problem = requestProblem(message)
  // An unreadable frame has no id to answer under, so JSON-RPC's own answer is
  // an error carrying `id: null`.
  if (problem) return rpcError(null, RPC_INVALID_REQUEST, REQUEST_PROBLEMS[problem])
  const { id, method, params } = message
  // A notification is a request with NO id member — decided here, after the
  // frame is known to be well formed. An earlier version treated `id === null`
  // as a notification too, so a malformed request vanished without a word.
  if (!('id' in message)) return null
  // Method-not-found outranks bad params: a caller naming a method this server
  // does not implement has to hear THAT, not a complaint about the arguments to
  // something that does not exist.
  if (!KNOWN_METHODS.has(method)) return rpcError(id, RPC_METHOD_NOT_FOUND, 'method not found')
  const badParams = paramsProblem(method, params)
  if (badParams) return rpcError(id, RPC_INVALID_PARAMS, badParams)
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        // Ours, not the caller's. See PROTOCOL_VERSION.
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'tmux-teams-acp-lanes', version: pluginVersion() },
      },
    }
  }
  // The spec says a receiver MUST answer ping with an empty result. Missing it
  // means a host health check reads this server as dead and drops it, which is
  // the silent-disconnection twin of the boot bug this file already had.
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'tools/call') {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      return rpcError(id, RPC_INVALID_PARAMS, 'tools/call params must be an object')
    }
    if (typeof params.name !== 'string') {
      return rpcError(id, RPC_INVALID_PARAMS, 'tools/call params.name must be a string')
    }
    const descriptor = TOOL_DESCRIPTORS.find((d) => d.name === params.name)
    // An unknown tool is a PROTOCOL error, not a tool that ran and failed. A
    // client holding a stale tool cache has to be able to tell those apart, and
    // reporting the first as the second is what makes that impossible.
    if (!descriptor) return rpcError(id, RPC_INVALID_PARAMS, 'no such tool')
    const badArgs = argumentsProblem(descriptor.inputSchema, params.arguments)
    if (badArgs) return rpcError(id, RPC_INVALID_PARAMS, badArgs)
    const payload = callTool(params.name, params.arguments, env, deps)
    const buildReply = (resolved) => ({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(resolved, null, 2) }],
        // Reserved for a tool that RAN and reported a problem — an unknown lane
        // (or, now, an unreachable one) is the only one left, and it is
        // genuinely a tool-level result.
        isError: Boolean(resolved?.error),
      },
    })
    // Only `acp_lane_probe`'s handler returns a Promise — it is the only tool
    // that spawns a process and has to wait on it. Every other handler still
    // returns a plain object, so `handle` still answers SYNCHRONOUSLY for
    // every caller that never reaches the async branch: no existing call site
    // awaits it, and none has to. The `.catch` is load-bearing, not
    // decoration — a rejected handler promise reaching a caller with nothing
    // to catch it is the EPIPE-takes-the-whole-gate-down shape this project
    // has already lost a release to once; `probeLanes` is written to never
    // reject, and this is the backstop for the day it does anyway.
    if (payload && typeof payload.then === 'function') {
      return payload.then(buildReply, () => buildReply({ error: PROBE_CRASHED }))
    }
    return buildReply(payload)
  }
  return rpcError(id, RPC_METHOD_NOT_FOUND, 'method not found')
}

export function serve({ input = process.stdin, output = process.stdout, env = process.env, deps } = {}) {
  // A host that closes its read pipe mid-call (disconnect, exit) delivers the
  // NEXT output.write() as an async 'error' event on the stream itself, not a
  // promise rejection — the `.catch(() => {})` a few lines below cannot see
  // it, because it backstops a rejecting `handle()`, a different failure than
  // a write-side EPIPE. This project has already lost a whole run to this
  // exact shape on a child's stdin (acp-review-client.mjs, acp-dispatch.mjs);
  // `output` gets the same swallow-and-move-on guard for the same reason: the
  // caller who broke the pipe already lost this reply, and nothing here can
  // un-break it, so an unhandled 'error' event killing every OTHER lane's
  // in-flight or queued result is a worse outcome than one lost write.
  output.on('error', () => {})
  const lines = createInterface({ input })
  lines.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      output.write(JSON.stringify({
        jsonrpc: '2.0', id: null, error: { code: RPC_PARSE_ERROR, message: 'parse error' },
      }) + '\n')
      return
    }
    // `handle` may answer synchronously (every method except a probe call) or
    // return a Promise (only `acp_lane_probe`). `Promise.resolve` normalises
    // both without changing the synchronous path's timing in practice, and
    // the `.catch` here is the same backstop `handle` already applies —
    // doubled deliberately, because a socket write after an unhandled
    // rejection killed a whole review gate in this project once already.
    Promise.resolve(handle(message, env, deps)).then((reply) => {
      if (reply) output.write(JSON.stringify(reply) + '\n')
    }).catch(() => {})
  })
  return lines
}

// Compare PATHS, not a URL against a hand-built string, and compare them
// through realpath. `import.meta.url` is a percent-encoded file URL, so on any
// install path carrying a space or a non-ASCII character the naive `file://` +
// argv[1] template never matches, `serve()` is never called, and node exits 0
// with an empty event loop — a server that is declared, launched and silently
// dead. Two review lanes raised that; it survived a manual stdio run only
// because this machine's paths are plain ASCII.
//
// The realpath half came from the TEST rather than from the review. The fix
// both lanes suggested (`fileURLToPath` vs `resolve`) is still wrong on macOS,
// where `/var` is a symlink to `/private/var` and Node's ESM loader resolves the
// module URL through it while `argv[1]` keeps the path as typed. Booting the
// thing found that; reading it twice would not have.
export function launchedDirectly(entry = process.argv[1]) {
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry))
  } catch {
    return false
  }
}

if (launchedDirectly()) serve()
