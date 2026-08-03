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
// kimi entry.
export const ROUTED_PROFILES = new Set(['zai'])
const ZAI_ENDPOINT = freeze({ host: 'api.z.ai', path: '/api/anthropic' })

export const REVIEW_PROFILES = freeze({
  agy: {
    id: 'agy', provider: 'google-antigravity', family: 'gemini', model: 'gemini-3.6-flash-high',
    displayModel: 'agy/gemini-3.6-flash-high',
    reviewMode: 'plan', osSandbox: 'bwrap', command: ['bunx', 'antigravity-acp@1.0.0'],
    config: { model: 'gemini-3.6-flash-high', mode: 'plan' },
  },
  kimi: {
    id: 'kimi', provider: 'kimi', family: 'kimi', model: 'opus',
    displayModel: 'kimi/opus',
    // The native `kimi acp` client needed a login this machine never had, so
    // every panel it sat on failed at `Authentication required`. The lane now
    // speaks Claude's ACP adapter against a routed profile instead, and the
    // `opus` alias resolves server-side from that profile.
    //
    // Which makes the label a claim about a machine-local file. `family` is
    // what the panel counts to prove three DISTINCT model families reviewed
    // this work — so an operator who re-points that profile at Anthropic while
    // the label still reads `kimi` would satisfy the exactly-three rule with
    // two seats from one family, and nothing in the receipt would disagree.
    // `claudeExecutable` is what stops that. The adapter resolves its Claude
    // binary from CLAUDE_CODE_EXECUTABLE, and this lane names a DIFFERENT
    // binary — the operator's `claude-kimi`, which carries Kimi's base URL,
    // key and config dir and then execs claude. The label is pinned to an
    // executable name the gate sets itself and a caller cannot supply, so
    // `kimi` and `claude` cannot silently become the same seat.
    reviewMode: 'plan', osSandbox: 'bwrap',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
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
    settingsFile: 'settings-zai.json',
    endpoint: ZAI_ENDPOINT,
    sessionSettings: { availableModels: ['glm-5.2'] },
    config: { model: 'glm-5.2', mode: 'default' },
  },
  claude: {
    id: 'claude', provider: 'anthropic', family: 'claude', model: 'claude-opus-4-8',
    displayModel: 'claude/opus-4.8',
    reviewMode: 'plan', osSandbox: 'bwrap',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
    sessionSettings: { availableModels: ['claude-opus-4-8'] },
    config: { model: 'claude-opus-4-8', mode: 'plan' },
  },
  codex: {
    id: 'codex', provider: 'openai', family: 'openai', model: 'gpt-5.6-sol',
    displayModel: 'openai/gpt-5.6-sol',
    reviewMode: 'plan', osSandbox: 'bwrap',
    command: ['npx', '-y', '@agentclientprotocol/codex-acp@1.1.7'],
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

const aliases = new Map([
  ['openai', 'openai'], ['codex', 'openai'], ['gpt', 'openai'],
  ['claude', 'claude'], ['anthropic', 'claude'],
  ['kimi', 'kimi'], ['moonshot', 'kimi'],
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
  if (/^claude[-_](?:zai|glm)(?:[-_ ]?acp)?$/.test(value)) return ['zai']
  const families = []
  if (/(?:^|[^a-z0-9])(?:antigravity|gemini|agy|google)(?:[^a-z0-9]|$)/.test(value)) families.push('gemini')
  if (/(?:^|[^a-z0-9])(?:kimi|moonshot)(?:[^a-z0-9]|$)/.test(value)) families.push('kimi')
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
  if (!profile.settingsFile) return null
  const override = source?.[`TMUX_TEAMS_REVIEW_${profile.id.toUpperCase()}_SETTINGS`]
  const home = source?.HOME ?? source?.USERPROFILE
  return override || (home ? join(home, '.claude', profile.settingsFile) : null)
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
// It was written for zai alone and hard-coded that one host; kimi now reaches
// its provider the same way, and a per-lane copy of this is how two lanes come
// to disagree about what counts as its own provider.
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
