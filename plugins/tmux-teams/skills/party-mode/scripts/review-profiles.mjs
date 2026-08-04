// Immutable ACP reviewer definitions. The caller gets argv arrays and a
// profile-scoped environment, never a shell command or ambient credential bag.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const runtimeKeys = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP',
  'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
])

const providerSecrets = {
  agy: ['AGY_API_KEY', 'ANTIGRAVITY_API_KEY', 'GOOGLE_API_KEY'],
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  qwen: [],
  zai: ['ZAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
}

const routedSettingsEnv = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
])

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

// A routed lane reaches its provider through a machine-local settings file the
// operator owns. Pinning the host here is what keeps `family` honest — see the
// qwen and zai entries.
export const ROUTED_PROFILES = new Set(['kimi', 'qwen', 'zai'])
const ZAI_ENDPOINT = freeze({ host: 'api.z.ai', path: '/api/anthropic' })
const QWEN_ENDPOINT = freeze({ host: 'token-plan.ap-southeast-1.maas.aliyuncs.com', path: '/apps/anthropic' })
// Master, 2026-08-04: `claude-kimi` reaches a K3 model, `claude` reaches opus —
// two genuinely different families down one adapter. That was always true and
// nothing proved it, so `provenFamilyKey` gave both lanes the identical
// `::unrouted` key and a panel seating them together counted two families as
// three. The settings file this lane already loads pins
// `ANTHROPIC_BASE_URL: https://api.kimi.com/coding/` and
// `ANTHROPIC_DEFAULT_OPUS_MODEL: k3`; registering the host makes the parent
// verify it before the child starts, exactly as it does for zai and qwen. The
// trailing slash is dropped because `validateRoutedEndpoint` compares
// `pathname.replace(/\/$/, '')`.
const KIMI_ENDPOINT = freeze({ host: 'api.kimi.com', path: '/coding' })

export const REVIEW_PROFILES = freeze({
  agy: {
    id: 'agy', provider: 'google-antigravity', family: 'gemini', model: 'gemini-3.6-flash-high',
    displayModel: 'agy/gemini-3.6-flash-high',
    reviewMode: 'plan', osSandbox: 'bwrap', command: ['bunx', 'antigravity-acp@1.0.0'],
    adapterPackage: 'antigravity-acp@1.0.0',
    config: { model: 'gemini-3.6-flash-high', mode: 'plan' },
  },
  kimi: {
    id: 'kimi', provider: 'kimi', family: 'kimi', model: 'opus',
    displayModel: 'kimi/opus',
    // Not seated by the current reviewer routes — qwen took that seat after the
    // Kimi provider quota failure — but pinned all the same. An unpinned lane
    // is not merely unused, it is indistinguishable from bare `claude`
    // (identical adapter package, both `::unrouted`), so leaving it unpinned
    // meant any future route that seated both would count two families as
    // three, and the gate would say PASS. Pinned, its key names api.kimi.com
    // and the parent refuses a settings file that redirects it.
    reviewMode: 'plan', osSandbox: 'bwrap',
    endpoint: KIMI_ENDPOINT,
    // A routed lane reads its base URL and credential from this file; without
    // the path, `loadRoutedEnvironment` finds nothing and `validateRoutedEndpoint`
    // refuses the lane outright — pinning without pointing at the settings is
    // how a pin turns a working lane into a dead one.
    settingsRelativePath: '.config/claude-profiles/kimi/settings.json',
    providerConfigDir: '.config/claude-profiles/kimi',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
    adapterPackage: '@agentclientprotocol/claude-agent-acp@0.61.0',
    claudeExecutable: 'claude-kimi',
    sessionSettings: { availableModels: ['opus'] },
    config: { model: 'opus', mode: 'plan' },
  },
  zai: {
    id: 'zai', provider: 'zai', family: 'zai', model: 'glm-5.2',
    displayModel: 'zai/glm-5.2',
    thinkingBudgetTokens: 4096,
    // glm-5.2 cannot hold plan mode and the JSON-only review protocol at once —
    // asked for both it answers prose and the parse fails, which is how this
    // lane failed every panel it sat on. It runs in default mode instead. What
    // made plan mode safe is not the word: the runner denies every permission
    // request, mounts no MCP server, and refuses a run that observed a tool
    // call. Those hold here unchanged.
    reviewMode: 'default', osSandbox: 'bwrap',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
    adapterPackage: '@agentclientprotocol/claude-agent-acp@0.61.0',
    claudeExecutable: 'claude-zai',
    settingsFile: 'settings-zai.json',
    settingsRelativePath: '.config/claude-profiles/zai/settings.json',
    providerConfigDir: '.config/claude-profiles/zai',
    endpoint: ZAI_ENDPOINT,
    sessionSettings: { availableModels: ['glm-5.2'] },
    config: { model: 'glm-5.2', mode: 'default' },
  },
  qwen: {
    id: 'qwen', provider: 'qwen', family: 'qwen', model: 'qwen3.8-max-preview',
    displayModel: 'qwen/qwen3.8-max-preview',
    reviewMode: 'plan', osSandbox: 'bwrap',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
    adapterPackage: '@agentclientprotocol/claude-agent-acp@0.61.0',
    claudeExecutable: 'claude-qwen',
    settingsRelativePath: '.config/claude-profiles/qwen/settings.json',
    providerConfigDir: '.config/claude-profiles/qwen',
    endpoint: QWEN_ENDPOINT,
    sessionSettings: { availableModels: ['qwen3.8-max-preview'] },
    config: { model: 'qwen3.8-max-preview', mode: 'plan' },
  },
  claude: {
    id: 'claude', provider: 'anthropic', family: 'claude', model: 'claude-opus-4-8',
    displayModel: 'claude/opus-4.8',
    reviewMode: 'plan', osSandbox: 'bwrap',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
    adapterPackage: '@agentclientprotocol/claude-agent-acp@0.61.0',
    sessionSettings: { availableModels: ['claude-opus-4-8'] },
    config: { model: 'claude-opus-4-8', mode: 'plan' },
  },
  codex: {
    id: 'codex', provider: 'openai', family: 'openai', model: 'gpt-5.6-sol',
    displayModel: 'openai/gpt-5.6-sol',
    reviewMode: 'plan', osSandbox: 'bwrap',
    command: ['npx', '-y', '@agentclientprotocol/codex-acp@1.1.7'],
    adapterPackage: '@agentclientprotocol/codex-acp@1.1.7',
    config: {
      model: 'gpt-5.6-sol',
      reasoning_effort: 'ultra',
      mode: 'read-only',
      collaboration_mode: 'plan',
    },
  },
})

// CLAUDE.md forbids Gemini 3.1 on every tmux-teams AGY route and says to fail
// closed on one. Until now the rule lived only in the pin above, which means it
// was enforced by whoever edited that line next: v0.13.1 shipped
// `gemini-3.1-pro-high` here with a test asserting the forbidden value was
// correct, and nothing compared either against the rule. This throws at import.
const PROHIBITED_MODEL = /(?:^|[^0-9a-z])gemini[-_ ]?3\.1(?:[^0-9]|$)/i

/** Reject a prohibited reviewer model rather than quietly running it. */
export function assertPermittedModel(model, where) {
  if (typeof model === 'string' && PROHIBITED_MODEL.test(model)) {
    throw new Error(`${where}: Gemini 3.1 is prohibited on tmux-teams review routes, got ${model}`)
  }
  return model
}

for (const profile of Object.values(REVIEW_PROFILES)) {
  assertPermittedModel(profile.model, `review profile ${profile.id}`)
  assertPermittedModel(profile.displayModel, `review profile ${profile.id} displayModel`)
  assertPermittedModel(profile.config?.model, `review profile ${profile.id} config`)
}

// `provenFamilyKey` below used to say `adapterPackage` was "taken from
// `command`" while actually reading a second, hand-copied field nothing
// bound to the first (GitHub #38 follow-up review — both r2-qwen and
// r2-codex2 independently named this: bump `command`'s pinned version and
// forget the string beside it, or declare two different `adapterPackage`
// labels over the byte-identical `command`, and the stale/mismatched copy
// launders a collision either way). This makes the claim true instead of
// describing what it wishes were true: every declared `adapterPackage` must
// appear verbatim inside its own `command`, checked here for every shipped
// profile, so the two can never drift apart silently again. Exported (rather
// than an inline loop) so the rule itself — not just its one-time result at
// import — has a name a test can call against a profile that is not part of
// the frozen table, without needing to construct a whole second module.
// Strengthened after r3-codex: `.includes()` was not enough. A command carrying
// a second, inert package-shaped token lets two profiles each declare a
// DIFFERENT `adapterPackage` while both "appear somewhere" in one byte-identical
// command — two provable identities over one binary, which is the collision this
// exists to stop. A profile's real identity is the final token `npx`/`bunx`
// resolves and execs, so that is the one position this binds against.
export function assertAdapterPackageBoundToCommand(profile, where = `review profile ${profile?.id}`) {
  if (typeof profile?.adapterPackage !== 'string' || !Array.isArray(profile.command)) return profile
  const last = profile.command[profile.command.length - 1]
  if (last !== profile.adapterPackage) {
    throw new Error(`${where}: adapterPackage "${profile.adapterPackage}" is not the command's final argument (found "${last}")`)
  }
  return profile
}

for (const profile of Object.values(REVIEW_PROFILES)) assertAdapterPackageBoundToCommand(profile)

const aliases = new Map([
  ['openai', 'openai'], ['codex', 'openai'], ['gpt', 'openai'],
  ['claude', 'claude'], ['anthropic', 'claude'],
  ['kimi', 'kimi'], ['moonshot', 'kimi'],
  ['qwen', 'qwen'],
  ['zai', 'zai'], ['z.ai', 'zai'], ['glm', 'zai'],
  ['gemini', 'gemini'], ['google', 'gemini'], ['google-antigravity', 'gemini'],
  ['antigravity', 'gemini'], ['agy', 'gemini'],
])

function normalizeFamilyValues(raw) {
  if (typeof raw !== 'string') return []
  const value = raw.trim().toLowerCase()
  if (!value) return []
  if (aliases.has(value)) return [aliases.get(value)]
  if (/^claude[-_]kimi(?:[-_ ]?acp)?$/.test(value)) return ['kimi']
  if (/^claude[-_]qwen(?:[-_ ]?acp)?$/.test(value)) return ['qwen']
  if (/^claude[-_](?:zai|glm)(?:[-_ ]?acp)?$/.test(value)) return ['zai']
  const families = []
  if (/(?:^|[^a-z0-9])(?:antigravity|gemini|agy|google)(?:[^a-z0-9]|$)/.test(value)) families.push('gemini')
  if (/(?:^|[^a-z0-9])(?:kimi|moonshot)(?:[^a-z0-9]|$)/.test(value)) families.push('kimi')
  if (/(?:^|[^a-z0-9])qwen(?:[0-9]|[^a-z0-9]|$)/.test(value)) families.push('qwen')
  if (/(?:^|[^a-z0-9])(?:zai|z\.ai|glm)(?:[^a-z0-9]|$)/.test(value)) families.push('zai')
  if (/(?:^|[^a-z0-9])(?:claude|anthropic)(?:[^a-z0-9]|$)/.test(value)) families.push('claude')
  if (/(?:^|[^a-z0-9])(?:gpt|openai|codex)(?:[^a-z0-9]|$)/.test(value)) families.push('openai')
  return [...new Set(families)]
}

/** Return every recognized family declared by a model/provider/profile input. */
export function declaredPrimaryFamilies(input) {
  if (input === null || input === undefined) return Object.freeze([])
  const candidates = typeof input === 'object'
    ? [
        input.family, input.provider, input.profile, input.model, input.id, input.name,
        input.primary, input.primaryProfile, input.primary_model,
      ]
    : [input]
  return Object.freeze([...new Set(candidates.flatMap(normalizeFamilyValues))])
}

/** Return one unambiguous policy family, or unknown for missing/conflicting declarations. */
export function normalizePrimaryFamily(input) {
  const families = declaredPrimaryFamilies(input)
  return families.length === 1 ? families[0] : 'unknown'
}

// `family` (above) is asserted straight from this table with no cross-check
// against anything the ACP wire reports — acp-review-client.mjs's return
// object has no `family` field at all, and `provider`/`model`/`displayModel`
// are echoed from the very `profile` object passed in, never observed (see
// runAcpReview's return statement). The ACP surface this repo speaks
// (initialize/session-new/session-set_config_option/session-prompt) exposes
// no "which upstream account or endpoint answered" fact, so an endpoint
// observed from the handshake is NOT implementable honestly today — inventing
// one would report "proven" from a value the same config supplied. This is
// the strongest claim that CAN be made before spawn, from data this table
// already pins and an operator cannot override at call time:
//   - which adapter PACKAGE will run (`adapterPackage`, bound to `command` by
//     the assertion above for every shipped profile — bumping one and not
//     the other now throws at import instead of silently laundering a
//     collision), and
//   - for a lane BOTH declaring an `endpoint` pin AND actually registered in
//     `ROUTED_PROFILES` (the set `buildProfileEnv` consults to decide whether
//     `validateRoutedEndpoint` ever runs before spawn), the exact endpoint
//     that parent-side check verifies (`endpoint`). See the inline comment
//     on the `endpoint` line below for why the registration check, not just
//     the shape of `endpoint`, is required.
//
// What this still cannot prove, and does not claim to: that the legacy
// UNROUTED Kimi lane (no `endpoint` pin, reached through the operator-owned
// `claude-kimi` executable) reaches a genuinely different upstream than a
// routed lane beside it. Current default routes use the endpoint-pinned qwen
// and zai profiles instead. A lane with neither an adapter distinction nor a
// parent-verified endpoint is `unrouted`, a bucket that says only "not
// provably pinned," never "provably distinct from a lane that is."
export function provenFamilyKey(profile) {
  if (!profile || typeof profile.adapterPackage !== 'string' || !profile.adapterPackage) return null
  const validEndpointShape = profile.endpoint &&
    typeof profile.endpoint.host === 'string' && typeof profile.endpoint.path === 'string'
  // Registration in `ROUTED_PROFILES` is required too, not just the shape of
  // `endpoint` on the profile object: a profile can declare endpoint-shaped
  // metadata without ever being wired into the set `buildProfileEnv` checks
  // before calling `validateRoutedEndpoint`, or that Set can be mutated
  // after import (`Object.freeze` does not stop `.add`/`.delete` on a Set)
  // -- and without this second check the key would still say "pinned" even
  // though nothing in the parent process ran the endpoint check for this
  // launch (r2-codex2 bypass #4).
  const endpoint = validEndpointShape && ROUTED_PROFILES.has(profile.id)
    ? `pinned:${profile.endpoint.host}${profile.endpoint.path}`
    : 'unrouted'
  return `${profile.adapterPackage}::${endpoint}`
}

// True when two or more of the given profiles cannot be PROVEN to be
// distinct identities. Two forms of that:
//   - two resolvable keys (see provenFamilyKey) are identical, or
//   - two or more profiles resolve to no key at all (no `adapterPackage`).
// The second clause used to be the opposite: a profile with no resolvable
// key was said to "contribute no evidence either way" and was filtered out
// before the uniqueness check, so two lanes that both omitted or misspelled
// `adapterPackage` (the field this used to key off) sailed through as "no
// evidence, therefore no collision" — r2-codex2's exact bypass #2, and the
// shipped test at the time asserted that as correct rather than as a defect.
// A single unresolved profile beside two resolved, distinct ones still
// passes — one unknown has nothing else unknown to compare against. It is
// specifically two or more unidentifiable lanes together, with nothing to
// tell them apart, that this now refuses to certify as diverse.
// True when two or more of the given keys cannot be PROVEN distinct: either two
// resolvable keys are identical, or two-or-more lanes resolve to no key at all.
// That second clause used to be a free pass — a `null` was filtered out before
// the uniqueness check, so two lanes that both omitted or misspelled
// `adapterPackage` read as "no evidence, therefore no collision" rather than
// what it actually is: nothing tells them apart either, and a fail-closed gate
// must not certify that as diverse. One unresolved lane beside two DISTINCT
// resolved ones still passes — a single unknown has nothing to be confused with.
//
// It takes keys rather than profiles because `review-gate.mjs` re-checks the
// FINAL panel from the `familyProvenKey` already recorded on each accepted
// review, and that second reader had its own copy of this rule with the old
// filter still in it (r3-codex probed `[null-reserve, null-a, agy]` through to
// `ok:true`). Two copies of one rule is how they drift; there is one now.
// round four, BLOCKER 5 (r4-codex, confirmed by r4-qwen's F-4 and the
// standing AGY objection this responds to rather than overriding): a single
// unresolved key beside two DISTINCT resolved ones is not automatically a
// pass. "One unknown has nothing else unknown to compare against" was true
// only when the unknown carries no other evidence at all. `qwen-shadow`
// proved otherwise -- it shipped the real, byte-identical qwen `command`
// array and `claudeExecutable`, declared no `adapterPackage` (so its key was
// null), and sat beside the real qwen lane: sameCommand:true,
// preflightCollision:false, gateOk:true. Its declared IDENTITY was unproven,
// but what it would actually EXEC was provably identical to a lane already in
// the panel -- that is not "no evidence", it is evidence of collision the key
// alone cannot see. `provenLaunchSignature` reads what would run instead of
// what the profile claims about itself, so it cannot be spoofed by the same
// omission that produces the null key. This does NOT make every unknown
// fatal (AGY's objection): an unknown whose command differs from every other
// lane's still passes, exactly as before -- see the accompanying test for a
// genuinely diverse panel with one unresolved lane.
export function provenLaunchSignature(profile) {
  if (!profile || !Array.isArray(profile.command) ||
      profile.command.some(part => typeof part !== 'string')) return null
  return JSON.stringify([profile.command, profile.claudeExecutable ?? null])
}

// The endpoint a lane is PINNED to, or null. This is the one routing fact the
// parent verifies before the child starts: `validateRoutedEndpoint` reads the
// lane's settings file and refuses it if the base URL is not this host and
// path. A declared settings path is not a substitute — an unpinned lane can
// name any file it likes, which is exactly the r5-qwen attack.
//
// Deliberately not folded into `provenLaunchSignature`. Appending a settings
// path to that tuple was tried first and reopened `qwen-shadow` in one line:
// the shadow copies the real command and executable and declares nothing else,
// so a flat tuple read the ABSENCE as a difference and passed it. Absence is
// not evidence — the same principle the null-key rule is built on — so a
// routing fact can only ever distinguish two lanes when BOTH carry one.
export function routingDeclaration(profile) {
  if (!profile || !ROUTED_PROFILES.has(profile.id)) return null
  const endpoint = profile.endpoint
  if (!endpoint || typeof endpoint.host !== 'string' || endpoint.host === '') return null
  return JSON.stringify([endpoint.host, endpoint.path ?? null])
}

// `launchSignatures`, when supplied, must be parallel to `keys` (same index
// meaning the same lane) and hold each lane's `provenLaunchSignature` (or
// null if unknown). Optional and back-compatible: every existing caller that
// passes only `keys` gets exactly the old behavior.
// Same bytes, different vendor: two lanes exec-identical on argv and executable
// are still two lanes when each is PINNED to a different verified endpoint.
// AGY raised this in round six — a provider added without its own wrapper
// binary shares the adapter command with every other claude-adapter lane, and
// refusing that panel is a shipped outage, the gate blocking the very release
// it exists to guard. The pin is not a claim the profile makes about itself:
// `validateRoutedEndpoint` reads the lane's settings file and refuses it if
// the base URL is not that host, before the child starts.
//
// Both sides must be pinned. A lane carrying no pin is not distinguished by
// its silence: that is `qwen-shadow`, which copies the real command and
// executable and simply omits the rest, and it is r5-qwen's attack too — drop
// `endpoint`, keep everything else. Reading absence as a difference is
// precisely the pass this whole rule exists to refuse.
function routesApart(routings, i, j) {
  if (!Array.isArray(routings)) return false
  const a = routings[i] ?? null
  const b = routings[j] ?? null
  return a !== null && b !== null && a !== b
}

export function provenFamilyKeysCollide(keys, launchSignatures = null, routings = null) {
  const list = keys ?? []
  if (list.filter(key => key === null).length >= 2) return true
  const known = list.filter(key => key !== null)
  if (new Set(known).size !== known.length) return true
  // Two lanes that EXEC THE SAME BYTES are one lane, whatever their keys say.
  // This used to run only where a key was null, on the theory that an attacker
  // hides by omitting `adapterPackage` — the shape r4-codex found. r5-qwen
  // showed the easier attack needs no hiding at all: copy the qwen profile,
  // change `id`, drop `endpoint` (or simply leave it out of ROUTED_PROFILES),
  // and keep `adapterPackage` honest. The keys then differ — `::unrouted`
  // against `::pinned:token-plan...` — so the uniqueness test above passes, the
  // null gate never opens, and two lanes running
  // `npx -y @agentclientprotocol/claude-agent-acp@0.61.0` with
  // `claudeExecutable: 'claude-qwen'` are certified as two families. Same
  // upstream, same account, same model, byte-identical argv.
  //
  // An endpoint pin distinguishes lanes that reach different providers; it
  // cannot distinguish two lanes that reach the same one, and a pin is a
  // declaration on a profile rather than a property of the launch. So the
  // signature is compared for EVERY lane, and a key that claims otherwise does
  // not get to overrule what is actually executed.
  if (Array.isArray(launchSignatures) && launchSignatures.length === list.length) {
    const seen = new Map()
    for (let i = 0; i < list.length; i += 1) {
      const signature = launchSignatures[i]
      if (signature === null || signature === undefined) continue
      // Every earlier lane on this signature, not just the first: with three
      // exec-identical lanes where only one pair routes apart, comparing
      // against a single remembered index lets the third slip past the pair it
      // actually duplicates.
      const earlier = seen.get(signature) ?? []
      if (earlier.some((j) => !routesApart(routings, j, i))) return true
      seen.set(signature, [...earlier, i])
    }
  }
  return false
}

export function provenFamilyCollision(profiles) {
  const list = profiles ?? []
  return provenFamilyKeysCollide(
    list.map(provenFamilyKey), list.map(provenLaunchSignature), list.map(routingDeclaration))
}


export function getReviewProfile(id) {
  const profile = REVIEW_PROFILES[id]
  if (!profile) throw new TypeError(`unknown review profile: ${id}`)
  return profile
}

export function loadProfileSettings(profileId, settingsLoader = () => ({})) {
  if (typeof settingsLoader !== 'function') throw new TypeError('settingsLoader must be a function')
  const profile = getReviewProfile(profileId)
  const loaded = settingsLoader(profile.id, profile)
  if (loaded === null || loaded === undefined) return { ...profile.config }
  if (typeof loaded !== 'object' || Array.isArray(loaded)) throw new TypeError('settingsLoader must return an object')
  // Profile pins win.  A loader may supply safe ACP settings but cannot swap a
  // model, mode, or adapter identity.
  return Object.freeze({ ...loaded, ...profile.config })
}

function settingsPath(profile, source) {
  const relativePath = profile.settingsRelativePath ?? (profile.settingsFile ? join('.claude', profile.settingsFile) : null)
  if (!relativePath) return null
  const override = source?.[`TMUX_TEAMS_REVIEW_${profile.id.toUpperCase()}_SETTINGS`]
  const home = source?.HOME ?? source?.USERPROFILE
  return override || (home ? join(home, relativePath) : null)
}

function loadRoutedEnvironment(profile, source, loader = file => JSON.parse(readFileSync(file, 'utf8'))) {
  const file = settingsPath(profile, source)
  if (!file || !existsSync(file)) return {}
  const parsed = loader(file, profile)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${profile.id} review settings must be a JSON object`)
  }
  const values = parsed.env
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {}
  return Object.fromEntries(Object.entries(values)
    .filter(([key, value]) => routedSettingsEnv.has(key) && value !== null && value !== undefined)
    .map(([key, value]) => [key, String(value)]))
}

// One check for every routed lane, driven by the `endpoint` the profile pins.
// Qwen and Zai each have their own host pin, so the parent process can reject a
// settings file that silently redirects either Claude ACP alias elsewhere.
//
// A lane that routes but pins nothing is refused rather than trusted: the panel
// counts `family` to prove three distinct families reviewed the work, and a
// family label backed by an unchecked, operator-editable base URL is a claim
// the receipt cannot support.
export function validateRoutedEndpoint(profile, env) {
  const pinned = profile.endpoint
  if (!pinned || typeof pinned.host !== 'string' || typeof pinned.path !== 'string') {
    throw new TypeError(`${profile.id} review routes its provider but pins no endpoint`)
  }
  const expected = `https://${pinned.host}${pinned.path}`
  const raw = env.ANTHROPIC_BASE_URL
  if (typeof raw !== 'string' || !raw) throw new TypeError(`${profile.id} review requires ANTHROPIC_BASE_URL`)
  let url
  try { url = new URL(raw) } catch { throw new TypeError(`${profile.id} review endpoint must be a valid URL`) }
  if (url.protocol !== 'https:' || url.hostname !== pinned.host ||
      (url.port && url.port !== '443') || url.username || url.password ||
      url.search || url.hash || url.pathname.replace(/\/$/, '') !== pinned.path) {
    throw new TypeError(`${profile.id} review endpoint must be ${expected}`)
  }
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY && !env.ZAI_API_KEY) {
    throw new TypeError(`${profile.id} review endpoint requires an explicit provider credential`)
  }
}

function executablePath(source) {
  const home = source?.HOME ?? source?.USERPROFILE
  const current = source?.PATH ?? source?.Path ?? ''
  if (!home) return current
  const candidates = [
    join(home, '.local', 'bin'),
    join(home, '.kimi-code', 'bin'),
    join(home, '.bun', 'bin'),
  ].filter(existsSync)
  return [...new Set([...candidates, ...current.split(delimiter).filter(Boolean)])].join(delimiter)
}

function trustedAgyBinary(source) {
  const home = source?.HOME ?? source?.USERPROFILE
  const candidates = [
    ...(home ? [join(home, '.local', 'bin', 'agy')] : []),
    '/usr/local/bin/agy',
    '/usr/bin/agy',
  ]
  const found = candidates.find(existsSync)
  return found ? realpathSync(found) : null
}

/**
 * Build the environment for one ACP child.  Only OS runtime plumbing and that
 * profile's credentials survive.  In particular ACP_CMD cannot redirect a
 * policy-owned launch to an arbitrary command.
 */
export function buildProfileEnv(profileId, source = process.env, {
  settingsLoader,
  agyBinaryResolver = trustedAgyBinary,
} = {}) {
  const profile = getReviewProfile(profileId)
  const env = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value === undefined || value === null) continue
    if (runtimeKeys.has(key) || key.startsWith('LC_')) env[key] = String(value)
  }
  const path = executablePath(source)
  if (path) env.PATH = path
  if (ROUTED_PROFILES.has(profile.id)) Object.assign(env, loadRoutedEnvironment(profile, source, settingsLoader))
  for (const key of providerSecrets[profile.id]) {
    if (source?.[key] !== undefined && source[key] !== null) env[key] = String(source[key])
  }
  if (profile.id === 'agy') {
    const agyBinary = agyBinaryResolver(source)
    if (!agyBinary) throw new TypeError('trusted agy executable not found')
    env.AGY_BIN = agyBinary
    env.AGY_SKIP_DOWNLOAD = '1'
  }
  if (ROUTED_PROFILES.has(profile.id) || profile.claudeExecutable || profile.id === 'claude') {
    env.CLAUDE_MODEL_CONFIG = JSON.stringify({ availableModels: [profile.model] })
  }
  // Set from the profile, never from the caller: `runtimeKeys` does not carry
  // this name, so the only way a lane can point the adapter at another Claude
  // binary is by declaring it here — which is what keeps a lane's family label
  // attached to something the gate chose.
  if (profile.claudeExecutable) env.CLAUDE_CODE_EXECUTABLE = profile.claudeExecutable
  if (Number.isSafeInteger(profile.thinkingBudgetTokens) && profile.thinkingBudgetTokens >= 0) {
    env.MAX_THINKING_TOKENS = String(profile.thinkingBudgetTokens)
  }
  if (ROUTED_PROFILES.has(profile.id)) validateRoutedEndpoint(profile, env)
  return Object.freeze(env)
}

export function buildAcpLaunch(profileId, {
  env = process.env,
  settingsLoader,
  routedSettingsLoader,
  agyBinaryResolver,
} = {}) {
  const profile = getReviewProfile(profileId)
  return Object.freeze({
    profile,
    command: Object.freeze([...profile.command]),
    env: buildProfileEnv(profileId, env, { settingsLoader: routedSettingsLoader, agyBinaryResolver }),
    settings: loadProfileSettings(profileId, settingsLoader),
  })
}
