#!/usr/bin/env node
// An MCP server that answers ONE question: which ACP review lanes exist here,
// and what does each one still need on THIS machine.
//
// Why it exists. The per-machine half of the ACP problem was solved in code on
// 2026-08-13 — `TMUX_TEAMS_REVIEW_<ID>_SETTINGS` and
// `TMUX_TEAMS_REVIEW_<ID>_ENV_FILE` let a profile live anywhere — and then
// nothing told anybody. The answer to "why does my lane refuse" was "read the
// comment at review-profiles.mjs:627", which is a document, not an answer.
//
// ## What it does with credentials, stated the way it behaves
//
// **It READS them.** Deciding whether a lane's configuration is valid means
// calling `buildAcpLaunch`, which reads the settings JSON, reads the credential
// file, and copies provider secrets out of the environment. An earlier version
// of this file and of ADR 0007 claimed "none is ever read", on the grounds that
// the returned object is discarded. A Codex advisor round-table refused that
// wording and was right: discarding a value you asked for is not declining to
// read it. Master's decision, 2026-08-16 — it reads them, and it never returns
// them.
//
// So the containment is about the OUTBOUND boundary, and it is enforced rather
// than promised:
//
//   - **No reply carries a credential VALUE.** Tested by serialising whole
//     replies built from secret-bearing fixtures, on the success path AND on
//     each failure path, for every provider-secret name this plugin knows.
//   - **Credential field NAMES do go out, deliberately.** This paragraph said
//     "or its field name" until 2026-08-17, and a Codex advisor reproduced the
//     contradiction: the `credential_missing` fix sentences name
//     `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and the lane's own keys,
//     because an operator who is not told the vocabulary writes the wrong key
//     into the right file and gets the same silence. A name is not a secret; a
//     value is. What was wrong was the CLAIM, not the bytes — and a contract
//     that its own code contradicts is worse than a narrower one, because it
//     teaches a reader to stop checking.
//   - A failure is reported as a CODE from a closed set with a sentence that is
//     a constant of this file. The raw exception text never reaches the wire.
//     That is not tidiness: the previous version exported
//     `String(error.message)` verbatim, so any future diagnostic downstream
//     that interpolated a token would have shipped it, and nothing here would
//     have noticed.
//
// ## What "valid configuration" does and does not prove
//
// It proves the parent-side checks pass. It does NOT prove the lane runs — no
// endpoint is contacted, no credential is accepted by anybody, no adapter is
// resolved, no session is negotiated. The first version called that
// `ready: true`, and the advisor reproduced the consequence in one command:
// with no HOME, no PATH and no credentials, the `claude` and `codex` lanes both
// reported ready. They report `unchecked` now, because for those two no
// parent-side check exists at all, and a diagnostic that says READY and then
// watches the real gate refuse is worse than no diagnostic.
//
// ## ADR 0003 stands
//
// A DISPATCHED agent receives no MCP server, enforced at runtime and asserted
// by the suite. This server is the operator's surface, which is a different
// thing. Nothing here adds an allowlist, a profile field or a companion branch
// that would make crossing that easier.
//
// ## Read-only, structurally
//
// Tools and their handlers come from ONE descriptor list, so the advertisement
// and the dispatcher cannot disagree about which names exist. That is weaker
// than the word this comment used to use: an advisor pointed out that a
// differently named hidden branch added later would still pass, so what is held
// here is auditability in one place, not impossibility.

import { readFileSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
// from those two refused a conforming
// `sampling: { listChanged: "vendor-extension" }`.
//
// Third correction of this line. It went every-capability, then three, and the
// answer is one — each narrowing was toward the spec and stopped where I
// guessed rather than where the document does.
// TWO axes, and they were one list until a codex-advisor lane sent
// `sampling: true` to the running server and got a success back. MCP 2025-06-18
// types four client capability members as objects; only `roots` types
// `listChanged` as a boolean. Collapsing that into one list meant the fix for
// the second axis — narrowing from every capability name to `roots` — silently
// narrowed the first one with it, and the suite stayed green because every
// capability test sent a well-formed object carrying an odd VALUE and never a
// member that was not an object at all.
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
  unclassified: 'the lane refused for a reason this server does not classify; run the gate for the detail',
})

// Classification reads the exception and keeps only which BUCKET it fell into.
// Nothing derived from the message text survives this function.
// Matched against the SHAPE this system throws, not against loose text anywhere
// in the message. Every phrase below is one this module's own dependencies
// raise as `<lane> review <phrase>`, and the anchor is what stops a settings
// PATH containing the same words from selecting a diagnosis — a panel lane
// pointed out that a caller who controls a filename controls the classification.
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
  // Which FILE failed decides the repair, and the previous version aimed every
  // filesystem error at the settings file — so an unreadable credential file
  // sent the operator to edit the wrong file and the wrong variable. A panel
  // lane caught it one commit after I introduced it.
  if (/\b(ENOENT|EACCES|EISDIR|ELOOP|EPERM)\b/.test(raw)) {
    // WHICH file failed is not knowable from the message, and the previous
    // version searched the raw text — INCLUDING THE PATH — for 'credential' or
    // '.env'. A caller who controls a filename therefore chose the diagnosis,
    // which is the exact invariant this module claims to hold. A panel lane
    // reproduced it directly.
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

// Fixes keyed on the CAUSE. The first version ignored `code` entirely and
// emitted every generic setup sentence the profile allowed, so `agy` — which
// fails because a trusted `agy` binary is absent — was told to repair the
// ADAPTER PACKAGE. A Codex advisor called that worse than an unclassified
// answer, because it sounds specific and sends the operator to the wrong file.
// Non-empty was never the property worth asserting; naming the thing that
// actually refused is.
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
  // The SAME function the validator calls, not a second list that agrees with
  // it today. Round three built this list here by hand and it drifted from the
  // check within one release — advertising names the endpoint validator did not
  // accept, which is a fix sentence that cannot repair the refusal it is
  // printed for.
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

export function fixesFor(id, profile, code) {
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
      return ['one of the values this lane forwards cannot be passed to a process — '
        + 'a NUL byte, or an environment larger than the launcher allows; the refusal names which',
        ...settings]
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
      fixes: fixesFor(id, profile, code),
      notProven: notProvenFor(profile),
    }
  }
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
])

export const TOOLS = deepFreeze(TOOL_DESCRIPTORS.map(({ handler, ...rest }) => rest))
const HANDLERS = new Map(TOOL_DESCRIPTORS.map((d) => [d.name, d.handler]))

export function callTool(name, args, env) {
  const handler = HANDLERS.get(name)
  if (!handler) return { error: 'no such tool', known: [...HANDLERS.keys()] }
  return handler(args, env)
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

// Per-method params, because an envelope check is not a params check. Round
// three validated `tools/call` and nothing else, so `initialize` with no params,
// `tools/list` with `params: []` and `ping` with unexpected params all answered
// SUCCESS — reproduced over the real stdio server in round four.
//
// `initialize` requires everything MCP 2025-06-18 requires: `protocolVersion`,
// `capabilities` and `clientInfo`.
//
// **This reverses a judgement, and the reversal is the interesting part.** The
// tolerant version was deliberate — refusing a host that omits a field buys
// this server nothing, no real host has ever initialized it, and the cost of
// being wrong is a dead feature nobody can diagnose. An advisor round accepted
// that reasoning with one condition: never sell it as strict conformance.
//
// Then a release panel raised it independently, against bytes that advertise
// `protocolVersion: '2025-06-18'`. Two distinct reviewers arriving at the same
// objection is this project's own must-fix bar, and the tie-breaker is that
// the tolerance protects a case nobody has observed while the advertisement is
// made on every single initialize. A conformant client sends all three; the
// rule now matches the version this server claims to speak.
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

export function handle(message, env = process.env) {
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
    const payload = callTool(params.name, params.arguments, env)
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        // Reserved for a tool that RAN and reported a problem — an unknown lane
        // is the only one left, and it is genuinely a tool-level result.
        isError: Boolean(payload?.error),
      },
    }
  }
  return rpcError(id, RPC_METHOD_NOT_FOUND, 'method not found')
}

export function serve({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
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
    const reply = handle(message, env)
    if (reply) output.write(JSON.stringify(reply) + '\n')
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
