// Immutable ACP reviewer definitions. The caller gets argv arrays and a
// profile-scoped environment, never a shell command or ambient credential bag.
import { accessSync, closeSync, constants as fsConstants, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const runtimeKeys = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP',
  'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
])

// Every declared profile needs an entry, even an empty one — `deepseek` had
// none, and it is the ONLY reserve the claude route has, so the gate's single
// substitution path crashed with "providerSecrets[profile.id] is not iterable"
// the first time anything reached it. Found 2026-08-14 by a documentation panel
// whose qwen lane returned an invalid schema: the substitution fired, and the
// thing meant to rescue the panel took it down instead.
//
// An empty list is a statement, not a gap: `qwen` and `deepseek` reach their
// provider through a routed wrapper's own settings, so no key is forwarded from
// this process. `tests/review-policy.test.mjs` holds every declared profile to
// having an entry, so the next one added cannot quietly inherit a crash.
const providerSecrets = {
  agy: ['AGY_API_KEY', 'ANTIGRAVITY_API_KEY', 'GOOGLE_API_KEY'],
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  qwen: [],
  deepseek: [],
  zai: ['ZAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
  ninerouter: [],
}

export const PROVIDER_SECRET_KEYS = providerSecrets

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
export const ROUTED_PROFILES = new Set(['deepseek', 'kimi', 'ninerouter', 'qwen', 'zai'])
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
// Loopback-only pin. `scheme: 'http'` is read by validateRoutedEndpoint; a
// remote name would defeat the whole point of a pin this machine can verify.
const NINEROUTER_ENDPOINT = freeze({ scheme: 'http', host: '127.0.0.1', port: '20128', path: '/v1' })

export const REVIEW_PROFILES = freeze({
  agy: {
    id: 'agy', provider: 'google-antigravity', family: 'gemini', model: 'gemini-3.7-flash-high',
    displayModel: 'agy/gemini-3.7-flash-high',
    reviewMode: 'plan', command: ['bunx', 'antigravity-acp@1.0.0'],
    adapterPackage: 'antigravity-acp@1.0.0',
    config: { model: 'gemini-3.7-flash-high', mode: 'plan' },
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
    reviewMode: 'plan',
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
    //
    // DEFAULT MODE IS NOT A CURE, AND THIS COMMENT SAID IT WAS. Measured
    // 2026-08-09 on Ubuntu 26.04: the lane reached review, ran 4m8s, glm-5.2
    // read the diff and answered -- and the answer was prose. It failed on
    // "agent output is not one strict JSON document" while running the mode
    // above. ADR 0004 ordered that contradiction recorded where a reader of
    // this file would find it; that is this note.
    //
    // THEN THE MODEL WAS MEASURED, AND IT IS NOT THE CAUSE. On 2026-08-13,
    // macOS, direct ACP with the profile selected by CLAUDE_CONFIG_DIR, this
    // lane returned ONE STRICT JSON DOCUMENT IN BOTH MODES on the same packet:
    // plan mode 4027 bytes in 87s, default mode 4170 bytes in 204s. Plan mode
    // was the faster and the cleaner of the two. So the paragraph at the top of
    // this comment is the record of a decision, not of a limitation -- glm-5.2
    // can hold plan mode and the JSON-only protocol at once, and the mode field
    // is not what stands between this lane and a parseable review.
    //
    // What differed on the day it answered prose is the shape of session/new.
    // plugins/tmux-teams/skills/party-mode/scripts/acp-review-client.mjs sends
    // settingSources: [], and measured on that same 2026-08-13 host the model
    // list then collapses to ['default'] and authentication fails outright,
    // while the companion's bare { cwd, mcpServers: [] } authenticates and
    // answers. That is one remaining difference and it is NOT proof of cause:
    // the 2026-08-09 lane authenticated fine and still answered prose. Whoever
    // picks this up is choosing between the session shape, a tolerant parse,
    // and a different model -- and should stop suspecting the mode.
    reviewMode: 'default',
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
    reviewMode: 'plan',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
    adapterPackage: '@agentclientprotocol/claude-agent-acp@0.61.0',
    claudeExecutable: 'claude-qwen',
    settingsRelativePath: '.config/claude-profiles/qwen/settings.json',
    providerConfigDir: '.config/claude-profiles/qwen',
    endpoint: QWEN_ENDPOINT,
    sessionSettings: { availableModels: ['qwen3.8-max-preview'] },
    config: { model: 'qwen3.8-max-preview', mode: 'plan' },
  },
  deepseek: {
    id: 'deepseek', provider: 'qwen', family: 'deepseek', model: 'deepseek-v4-flash-0731',
    displayModel: 'deepseek/v4-flash-0731',
    // Same binary and same gateway as the `qwen` lane above — `claude-qwen`
    // reaches BOTH, because the profile it loads maps the model a caller asks
    // for onto a vendor: `ANTHROPIC_DEFAULT_OPUS_MODEL: qwen3.8-max`,
    // `ANTHROPIC_DEFAULT_SONNET_MODEL: deepseek-v4-flash-0731`. Measured rather
    // than read off the settings file, because the AGY adapter taught this repo
    // that a configured model can be silently ignored: asked for its identifier,
    // `--model opus` answered `qwen3.8-max-preview` and `--model sonnet`
    // answered `deepseek-v4-flash-0731` (2026-08-08).
    //
    // It shares `QWEN_ENDPOINT` and the adapter package with `qwen`, so
    // `provenFamilyKey` gives the two lanes an IDENTICAL key and they can never
    // sit on one panel. That is deliberate and is left alone: the key proves
    // where a lane routes, not which model answered, and one self-reported
    // identifier is not the evidence a release gate should count a family on.
    // Nothing here needs a new rule — `planFallback` re-runs `validReviewerSet`
    // after every substitution, so a panel that would seat both refuses itself.
    // Precisely: deepseek CAN replace a failed qwen (the swap leaves
    // [zai, deepseek, agy] and validates); what it cannot do is sit beside it.
    reviewMode: 'plan',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
    adapterPackage: '@agentclientprotocol/claude-agent-acp@0.61.0',
    claudeExecutable: 'claude-qwen',
    settingsRelativePath: '.config/claude-profiles/qwen/settings.json',
    providerConfigDir: '.config/claude-profiles/qwen',
    endpoint: QWEN_ENDPOINT,
    // The alias this gateway must be ASKED for, declared rather than left as a
    // mismatch: the pin demands one value and compares it against this, while
    // `model` above stays the identity that gets recorded. Until 2026-08-14 the
    // two were simply inconsistent, so every attempt to seat this lane was
    // refused at `stage: config` — and since it is the claude route's only
    // reserve, the gate had no working substitution at all.
    requestModel: 'sonnet',
    sessionSettings: { availableModels: ['sonnet'] },
    config: { model: 'sonnet', mode: 'plan' },
  },
  claude: {
    id: 'claude', provider: 'anthropic', family: 'claude', model: 'claude-opus-4-8',
    displayModel: 'claude/opus-4.8',
    reviewMode: 'plan',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
    adapterPackage: '@agentclientprotocol/claude-agent-acp@0.61.0',
    sessionSettings: { availableModels: ['claude-opus-4-8'] },
    config: { model: 'claude-opus-4-8', mode: 'plan' },
  },
  ninerouter: {
    // 2026-08-24, Master-approved: hosts whose ONLY reviewer route is the
    // operator's own local 9Router gateway (claude-9r wrapper -> loopback
    // proxy). Family `zai` is a DECLARATION about which upstream family this
    // lane reaches (glm-5.2-class through the gateway), same as every other
    // `family` label in this table; the pin is what makes it provable — here
    // http against an explicit loopback host, never a remote name.
    // The gateway serves the glm family under its own routed name and the
    // wrapper maps a PUBLIC ALIAS onto it: `--model opus` answers through
    // `zenmux/z-ai/glm-5.3-free` (measured 2026-08-24, probe returned OK;
    // bare `glm-5.2` answered `-32603 model may not exist`). Same shape as
    // deepseek: `model` is the identity this panel records; `requestModel`
    // is the alias the wire is asked for; ANTHROPIC_DEFAULT_OPUS_MODEL in
    // the lane's settings file maps alias -> vendor id.
    // Master, 2026-08-24: the lane calls the wrapper's DEFAULT model — no
    // alias pinning, no settings-side model mapping, nothing the wrapper does
    // not already do (its own ANTHROPIC_MODEL=deepseek-v4-flash). `model` is
    // therefore what the wrapper actually answers as, measured by probe.
    id: 'ninerouter', provider: 'ninerouter', family: 'zai', model: 'deepseek-v4-flash',
    displayModel: 'ninerouter/deepseek-v4-flash (wrapper default)',
    reviewMode: 'plan',
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.61.0'],
    adapterPackage: '@agentclientprotocol/claude-agent-acp@0.61.0',
    claudeExecutable: 'claude-9r',
    settingsRelativePath: '.config/claude-profiles/ninerouter/settings.json',
    providerConfigDir: '.config/claude-profiles/ninerouter',
    endpoint: NINEROUTER_ENDPOINT,
  },
  codex: {
    id: 'codex', provider: 'openai', family: 'openai', model: 'gpt-5.6-sol',
    displayModel: 'openai/gpt-5.6-sol',
    reviewMode: 'plan',
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
  const executed = executedPackage(profile.command)
  if (executed !== profile.adapterPackage) {
    throw new Error(`${where}: adapterPackage "${profile.adapterPackage}" is not the package this command runs (found ${
      executed === null ? 'no package at all' : `"${executed}"`})`)
  }
  return profile
}

// The package a runner actually EXECUTES is its first positional argument, not
// its last token. `npm exec -- <pkg> [args...]` and `bunx <package> [args...]`
// both say so in their own help.
//
// This read `.includes()` until 2026-08-04 and then, briefly, `.at(-1)` — and
// the second was worse than the first. r6-codex probed it: with
// `['npx', '@agentclientprotocol/codex-acp@1.1.7', '-y', 'antigravity-acp@1.0.0']`
// npx runs codex-acp and treats the rest as ITS arguments, while the binder
// certified the command as bound to the agy package because that string sat
// last. Two profiles could then declare different packages, execute the same
// one, and present different family keys AND different launch signatures to the
// panel. The accompanying test asserted that acceptance was correct, so the
// gate and its test agreed with each other and not with npx.
function executedPackage(command) {
  for (let i = 1; i < command.length; i += 1) {
    const token = command[i]
    if (typeof token !== 'string') return null
    if (token === '--') continue
    // `-p`/`--package` name a package to INSTALL and take a value; anything
    // after them is still not the thing being run, so a command using them is
    // refused rather than guessed at.
    if (token === '-p' || token === '--package') return null
    if (token.startsWith('-')) continue
    return token
  }
  return null
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
  if (/^claude[-_]deepseek(?:[-_ ]?acp)?$/.test(value)) return ['deepseek']
  const families = []
  if (/(?:^|[^a-z0-9])(?:antigravity|gemini|agy|google)(?:[^a-z0-9]|$)/.test(value)) families.push('gemini')
  if (/(?:^|[^a-z0-9])(?:kimi|moonshot)(?:[^a-z0-9]|$)/.test(value)) families.push('kimi')
  if (/(?:^|[^a-z0-9])qwen(?:[0-9]|[^a-z0-9]|$)/.test(value)) families.push('qwen')
  // `deepseek` SHIPS as a profile and was recognized by nothing: neither the
  // alias map nor any regex named it, so `normalizePrimaryFamily('deepseek')`
  // answered 'unknown' — and the lane reached its seat through a gateway that
  // also serves qwen, so the nearest wrong answer was 'qwen'. A panel lane
  // found it. A family the panel counts on for distinctness must be nameable.
  if (/(?:^|[^a-z0-9])deep[-_ ]?seek(?:[0-9]|[^a-z0-9]|$)/.test(value)) families.push('deepseek')
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

// GitHub #43: nine functions used to answer "would these two lanes run the
// same thing?" (provenFamilyKey, provenLaunchSignature, launchArgv,
// resolvedExecutable, routingDeclaration, routesApart,
// launchDeclaredButUnreadable, provenFamilyKeysCollide,
// provenFamilyCollision). `laneIdentity` is the one lookup that replaces the
// four a caller had to make together and keep in sync across two files
// (`provenFamilyKey` + `provenLaunchSignature` + `routingDeclaration` +
// `launchDeclaredButUnreadable`). It never returns a bare null standing in
// for "nothing to say" -- a null erases exactly the distinction r7-codex
// needed:
//
//   - `{ undeclared: true }` -- the profile names no launch at all. Silence
//     cannot run, so ONE such lane may still sit beside two identified,
//     distinct ones with nothing to compare it against (AGY's standing
//     objection, honored since round four's BLOCKER 5).
//   - `{ unreadable: true, reason }` -- the profile names a launch, but
//     `launchArgv` cannot read it (a non-string command/arg part). A
//     malformed declaration CAN still run -- node coerces the value -- so
//     this refuses outright rather than taking the "one unknown is fine"
//     latitude above. Collapsing this into `undeclared` is precisely the
//     regression the mutation test on this function exists to catch
//     (r7-codex: `[node, MOCK, 123]` beside a real lane, certified because
//     the loop `continue`d past a null it should have failed closed on).
//   - `{ signature, family, routing }` -- everything this file can prove
//     about a launch that DID read cleanly. `family` is `provenFamilyKey`
//     again (kept, not reinvented -- see the export below); `signature` is
//     what the launch actually resolves to, unchanged from the pre-#43
//     `provenLaunchSignature` body; `routing` is the parent-verified
//     endpoint pin, unchanged from the pre-#43 `routingDeclaration` body.
export function laneIdentity(profile) {
  if (!profile) return Object.freeze({ undeclared: true })
  const declared = profile.command !== undefined && profile.command !== null
  if (!declared) return Object.freeze({ undeclared: true })
  const argv = launchArgv(profile)
  if (argv === null) {
    return Object.freeze({ unreadable: true, reason: 'declared command/args could not be read as argv' })
  }
  return Object.freeze({
    signature: JSON.stringify([argv, resolvedExecutable(profile.claudeExecutable) ?? null]),
    family: provenFamilyKey(profile),
    routing: routingDeclaration(profile),
  })
}

// Kept as its own export -- review-policy.test.mjs and the collision check
// below compare a launch signature on its own, and "what would actually run"
// reads better as one value than as a field a caller has to know to pull off
// `laneIdentity`. Same computation as before #43, sourced from one place now.
export function provenLaunchSignature(profile) {
  return laneIdentity(profile).signature ?? null
}

// The argv a lane would actually run, in EITHER shape the system uses.
//
// The shipped profiles declare `command` as a whole array. The execution layer
// does not: `runAcpReview` (acp-review-client.mjs) requires `command` to be a
// STRING and takes `args` beside it. Reading only the array shape meant the
// diversity gate was blind to the shape the client executes — it returned null
// and the comparison was skipped, which is how r6-qwen got two exec-identical
// lanes certified. Normalising both here is the fix; failing closed on two
// unreadable launches (below) is the backstop.
export function launchArgv(profile) {
  if (!profile) return null
  // `args` counts in BOTH shapes. r7-codex: an array `command` beside an `args`
  // array dropped the args entirely, so two lanes differing only there read as
  // one launch — and `runAcpReview` appends `args` whichever way `command` was
  // declared. A profile that declares neither is unchanged.
  const extra = profile.args ?? []
  if (!Array.isArray(extra) || extra.some(part => typeof part !== 'string')) return null
  if (Array.isArray(profile.command)) {
    return profile.command.every(part => typeof part === 'string') ? [...profile.command, ...extra] : null
  }
  if (typeof profile.command !== 'string' || profile.command === '') return null
  return [profile.command, ...extra]
}

// The executable a lane runs, resolved through PATH to a real path when this
// machine can see it, and otherwise the name as declared.
//
// r6-codex/Amelia: the signature compared STRINGS and called them bytes.
// `claude-qwen` and an alias symlinked to it are the same wrapper, the same
// settings dir and the same upstream account — two different strings, so the
// panel counted two families. Resolving closes it in the direction that
// matters: two names for one file now collapse to one path.
//
// A name this machine cannot resolve falls back to itself. That is weaker than
// a path and deliberately so — two lanes that BOTH fail to resolve compare by
// name exactly as before, and a lane whose executable does not exist here will
// fail to launch long before the panel's verdict matters.
function resolvedExecutable(name) {
  if (typeof name !== 'string' || name === '') return name ?? null
  // The PATH the CHILD gets, not this process's. r7-codex: `buildProfileEnv`
  // hands the child a PATH with `~/.local/bin`, `~/.kimi-code/bin` and
  // `~/.bun/bin` in front, so resolving against `process.env.PATH` could name a
  // different file than the one that would actually run — a proof about a
  // binary nobody executes.
  const directories = executablePath(process.env).split(delimiter).filter(Boolean)
  for (const dir of name.includes('/') ? [''] : directories) {
    const candidate = dir === '' ? name : join(dir, name)
    try {
      if (existsSync(candidate)) return realpathSync(candidate)
    } catch { /* unreadable — try the next one */ }
  }
  return name
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
//
// No longer exported (#43): the only caller outside this file went through
// `review-gate.mjs`, which now reads this off `laneIdentity(profile).routing`
// instead of importing the function directly.
function routingDeclaration(profile) {
  if (!profile || !ROUTED_PROFILES.has(profile.id)) return null
  const endpoint = profile.endpoint
  // The SAME shape `validateRoutedEndpoint` demands — host AND path, both
  // strings. This required only a non-empty host and serialized a missing path
  // as `null`, so `routesApart()` could certify two byte-identical launches as
  // distinct on the strength of metadata the validator standing next to it
  // would reject. A panel lane read the two functions against each other.
  //
  // A pin that cannot pass validation is not a pin, and exempting a collision
  // on one is the bypass this whole check exists to close.
  if (!endpoint || typeof endpoint.host !== 'string' || endpoint.host === '') return null
  // A string, INCLUDING the empty one. `validateRoutedEndpoint` accepts `''` —
  // `https://host` has pathname `/`, which its trailing-slash strip turns into
  // `''` — so a host-root endpoint is a legitimate pin. Refusing it here made
  // the two functions disagree in the direction that FALSELY BLOCKS a genuinely
  // distinct routed family, which a panel lane named exactly. The shape they
  // must agree on is "both are strings", and that is the shape checked.
  if (typeof endpoint.path !== 'string') return null
  return JSON.stringify([endpoint.host, endpoint.path])
}

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

// Two or more lanes collide when nothing here can tell them apart. Folded
// from the old `provenFamilyKeysCollide` + `launchDeclaredButUnreadable` pair
// (#43) into the one function every caller actually wants; the decision
// itself is UNCHANGED, not simplified, because two genuinely independent
// kinds of evidence still feed it and dropping either reopens a shipped
// bypass:
//
//   - UNREADABLE overrides everything. `laneIdentity` says so directly now
//     instead of a separate `launchDeclaredButUnreadable` pass — r7-codex.
//   - FAMILY: `provenFamilyKey`, checked directly rather than through
//     `laneIdentity` because it is not gated on the launch being readable —
//     a profile can declare a real `adapterPackage` and still be
//     `undeclared` or `unreadable` on its launch, and two lanes that BOTH
//     omit or misspell `adapterPackage` (both null) are exactly as
//     unprovable as two that share one value (r2-codex2 bypass #2). This is
//     also the axis that still matters when two lanes share one declared
//     package but differ only in incidental trailing args: an identical
//     declared identity is not made diverse by an argument neither the
//     vendor pin nor the package name explains.
//   - LAUNCH: `signature` + `routing` from `laneIdentity`. Two lanes whose
//     launch cannot be compared at all (two `undeclared`) fail closed the
//     same way two null keys do; two IDENTIFIED lanes with the same
//     signature collide unless BOTH are pinned to different verified
//     endpoints (AGY round six) — a pin distinguishes same-bytes lanes
//     reaching different providers, it does not manufacture a difference
//     neither side declares (r5-qwen: dropping the pin is not a distinction).
export function provenFamilyCollision(profiles) {
  const list = profiles ?? []
  if (list.some(profile => laneIdentity(profile).unreadable === true)) return true

  const keys = list.map(provenFamilyKey)
  if (keys.filter(key => key === null).length >= 2) return true
  const knownKeys = keys.filter(key => key !== null)
  if (new Set(knownKeys).size !== knownKeys.length) return true

  // Two lanes that EXEC THE SAME BYTES are one lane, whatever their keys say
  // (r4-codex's `qwen-shadow`: real command, no `adapterPackage`, null key,
  // byte-identical launch). So the signature is compared for EVERY lane
  // regardless of what the key check above already found.
  const signatures = list.map(provenLaunchSignature)
  const routings = list.map(routingDeclaration)
  if (signatures.filter(signature => signature === null).length >= 2) return true
  const seen = new Map()
  for (let i = 0; i < list.length; i += 1) {
    const signature = signatures[i]
    if (signature === null) continue
    // Every earlier lane on this signature, not just the first: with three
    // exec-identical lanes where only one pair routes apart, comparing
    // against a single remembered index lets the third slip past the pair it
    // actually duplicates.
    const earlier = seen.get(signature) ?? []
    if (earlier.some(j => !routesApart(routings, j, i))) return true
    seen.set(signature, [...earlier, i])
  }
  return false
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

// A profile whose credential is NOT in its settings JSON. Measured 2026-08-13 on
// the Ubuntu 26.04 review host: its `claude-zai` wrapper keeps
// `ANTHROPIC_BASE_URL` in `~/.claude/profiles/zai.json` and the token in a
// sibling `zai.env`, deliberately, so the secret never sits in a JSON file. That
// is better hygiene than assuming both live together, and it made every routed
// lane refuse there with "requires an explicit provider credential" — the gate
// could only read the JSON.
//
// The operator names the file; this module keeps knowing nothing about where a
// profile lives. Values pass the SAME `routedSettingsEnv` allowlist as the JSON
// ones, so pointing at a stray file cannot smuggle arbitrary environment into a
// lane, and the settings JSON wins on any key present in both — a credential
// file may ADD a secret, never redirect an endpoint.
// The keys a routed lane's own files may supply: the shared endpoint vocabulary
// plus THAT LANE's declared provider secrets, and nothing else.
//
// The second half was missing until 2026-08-17 and it made the diagnostic lie.
// `validateRoutedEndpoint` accepts `env.ZAI_API_KEY`, and the ambient
// environment reaches it through the `providerSecrets` loop in
// `buildProfileEnv` — but this allowlist dropped the identical key when it came
// from the env file, so `acp-lanes-mcp.mjs` told a zai operator to point
// `TMUX_TEAMS_REVIEW_ZAI_ENV_FILE` at the file holding it and the lane refused
// exactly as before. A Codex advisor reproduced it: same key, `valid` ambient
// and `invalid` from the prescribed file. Widened per lane rather than
// globally — a lane gains only the secret names it already declares, so a stray
// file still cannot smuggle arbitrary environment anywhere.
// EXPORTED because a repair sentence promised what this set decides and named a
// smaller one. `acceptedCredentialNames` is the credential subset; the loader
// honours the routed settings names too, so "any other name in it is ignored"
// was false by four names. A lane raised it in round six and again in round
// seven after I deferred it as single-family — which is the reversal condition
// written into the roadmap.
export function acceptedRoutedKeys(profile) {
  return new Set([...routedSettingsEnv, ...(providerSecrets[profile.id] ?? [])])
}

function loadRoutedCredentialFile(profile, source, reader = file => readFileSync(file, 'utf8')) {
  const file = source?.[`TMUX_TEAMS_REVIEW_${profile.id.toUpperCase()}_ENV_FILE`]
  if (!file || !existsSync(file)) return {}
  const accepted = acceptedRoutedKeys(profile)
  const out = {}
  // A read failure here is about the CREDENTIAL file, and the only place that
  // fact exists is right here. Two panel families reported that
  // `credential_unreadable` was unreachable from any reply the server can
  // produce: the diagnostic and the argument to carry it were added together,
  // and no caller ever passed it, so an unreadable credential file kept
  // prescribing the settings-file repair. The exception now carries the
  // identity instead of the caller guessing from a path it does not own.
  let contents
  try {
    contents = String(reader(file))
  } catch (cause) {
    throw Object.assign(new Error(`${profile.id} review credential file could not be read: ${cause.code ?? 'read failed'}`),
      { code: 'credential_unreadable', fileKind: 'credential', cause })
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim()
    if (!accepted.has(key)) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') ||
        (value[0] === "'" && value.at(-1) === "'"))) value = value.slice(1, -1)
    if (value) out[key] = value
  }
  return out
}

function loadRoutedEnvironment(profile, source, loader = file => JSON.parse(readFileSync(file, 'utf8'))) {
  const credentials = loadRoutedCredentialFile(profile, source)
  const file = settingsPath(profile, source)
  if (!file || !existsSync(file)) return credentials
  const parsed = loader(file, profile)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${profile.id} review settings must be a JSON object`)
  }
  const values = parsed.env
  if (!values || typeof values !== 'object' || Array.isArray(values)) return credentials
  // Settings JSON last: it wins every key it declares, so a credential file can
  // only supply what the profile did not.
  return {
    ...credentials,
    ...Object.fromEntries(Object.entries(values)
      .filter(([key, value]) => acceptedRoutedKeys(profile).has(key) && value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])),
  }
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
  // A pin is scheme-carrying: every shipped remote provider pins https, and the
  // local-gateway profile (`ninerouter`, added 2026-08-24 for hosts whose only
  // reviewer route is the operator's own 9Router proxy) pins http against an
  // explicit loopback host. The scheme comes from the PIN, not from the caller,
  // so a settings file still cannot redirect one of these lanes to a scheme the
  // profile never declared.
  const shownPort = pinned.port ? `:${pinned.port}` : ''
  const expected = `${pinned.scheme ?? 'https'}://${pinned.host}${shownPort}${pinned.path}`
  const expectedScheme = `${pinned.scheme ?? 'https'}:`
  const raw = env.ANTHROPIC_BASE_URL
  if (typeof raw !== 'string' || !raw) throw new TypeError(`${profile.id} review requires ANTHROPIC_BASE_URL`)
  let url
  try { url = new URL(raw) } catch { throw new TypeError(`${profile.id} review endpoint must be a valid URL`) }
  const expectedPort = pinned.port ?? ''
  const gotDefault = !url.port
  if (url.protocol !== expectedScheme || url.hostname !== pinned.host ||
      (!gotDefault && url.port !== expectedPort) || (gotDefault && expectedPort) ||
      url.username || url.password ||
      url.search || url.hash || url.pathname.replace(/\/$/, '') !== pinned.path) {
    throw new TypeError(`${profile.id} review endpoint must be ${expected}`)
  }
  if (!acceptedCredential(profile, env)) {
    throw new TypeError(`${profile.id} review endpoint requires an explicit provider credential`)
  }
}

// The list of names that COUNT as this lane's credential, and it has to be the
// same list the loader reads and the same list the diagnostic advertises.
//
// It was not. Until 2026-08-17 this check named three keys literally —
// `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY` — which is why
// `ZAI_API_KEY` worked and `KIMI_API_KEY` did not, from any source. Round three
// widened `acceptedRoutedKeys` so the loader would READ a lane's own secret
// names, and stopped there; a Codex advisor reproduced the consequence in round
// four: the Kimi lane repeating the exact defect that had just been "fixed" for
// Zai, with `acp-lanes-mcp.mjs` printing the key names as the repair.
//
// **The half that shipped was the half that advertises.** Derived from
// `providerSecrets` now, so a lane added later cannot inherit the gap — and an
// empty list is still a statement: `qwen` and `deepseek` forward nothing of
// their own and are authenticated by the ANTHROPIC_* pair alone.
export function acceptedCredentialNames(profile) {
  return ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', ...(providerSecrets[profile.id] ?? [])]
}

// A value Node cannot put in a child environment is not a credential, whatever
// it looks like. `Boolean(value)` accepted a NUL-bearing string, so
// `acp_lane_status` answered `valid` for a configuration whose own
// `buildAcpLaunch().env` makes process creation throw
// `ERR_INVALID_ARG_VALUE` — a lane reproduced exactly that. The status of a
// configuration that cannot start a process is not "valid".
function spawnableValue(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\u0000')
}

function acceptedCredential(profile, env) {
  return acceptedCredentialNames(profile).some((key) => spawnableValue(env?.[key]))
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

// The places a trusted `agy` is accepted from, exported so a diagnostic can
// name exactly what was searched instead of guessing. `acp-lanes-mcp.mjs` told
// an operator to repair the ADAPTER PACKAGE when this check was what refused —
// a specific answer about the wrong executable, which a Codex advisor called
// worse than an unclassified one because it sounds authoritative.
export const AGY_BINARY_NAME = 'agy'

// The POSIX locale variables, by name. Everything else beginning `LC_` is a
// name somebody chose, and this file's promise is that no such name reaches a
// child.
const POSIX_LOCALE_VARS = new Set([
  'LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_MONETARY',
  'LC_NUMERIC', 'LC_TIME', 'LC_ADDRESS', 'LC_IDENTIFICATION', 'LC_MEASUREMENT',
  'LC_NAME', 'LC_PAPER', 'LC_TELEPHONE',
])

export function agyBinaryCandidates(source) {
  const home = source?.HOME ?? source?.USERPROFILE
  return [
    ...(home ? [join(home, '.local', 'bin', AGY_BINARY_NAME)] : []),
    `/usr/local/bin/${AGY_BINARY_NAME}`,
    `/usr/bin/${AGY_BINARY_NAME}`,
  ]
}

// The same list with `$HOME` left UNRESOLVED, for anything that reports a
// refusal outward. `acp-lanes-mcp.mjs` interpolated the resolved form into its
// fix sentence, and a Codex advisor showed what that costs: with a credential
// value also present in `HOME`, the credential appeared in the reply — through
// the path diagnostic, never through a credential field, which is exactly how
// a denylist-shaped guard gets beaten. A constant is also the clearer thing to
// print at an operator.
export const AGY_BINARY_CANDIDATE_FORMS = Object.freeze([
  `$HOME/.local/bin/${AGY_BINARY_NAME}`,
  `/usr/local/bin/${AGY_BINARY_NAME}`,
  `/usr/bin/${AGY_BINARY_NAME}`,
])

// `existsSync` was the whole check until 2026-08-17, so a mode-0644 file at a
// candidate path — or a DIRECTORY named `agy` — made the lane report a valid
// configuration while executing it failed `EACCES`. Reproduced by a Codex
// advisor. Executable discovery is the one parent-side fact this lane claims to
// establish, so `exists` is not enough: it must be a regular file this process
// can execute.
function executableCandidate(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

// A shebang naming an interpreter that is not here. `executableCandidate` says
// the file is executable and it IS — the kernel would accept it and then fail
// to find `#!/usr/bin/env whatever`, so the lane answers `valid` for a
// configuration that cannot start.
//
// Two panel families raised it across two rounds, and the defence recorded here
// — "proving otherwise means EXECUTING the candidate, which turns a read-only
// tool into an acting one" — rested on a choice that does not exist. The
// alternative was never `valid` versus running the file: `unchecked` is already
// in the result vocabulary and describes this state exactly, WITHOUT executing
// anything. Reading the first line of a file is not running it.
export function shebangInterpreterMissing(path, { pathValue = null } = {}) {
  let head = ''
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(256)
      head = buf.subarray(0, readSync(fd, buf, 0, 256, 0)).toString('utf8')
    } finally { closeSync(fd) }
  } catch {
    return null                    // unreadable is a different diagnosis
  }
  if (!head.startsWith('#!')) return null       // a binary, or no shebang: nothing to check
  const line = head.split('\n', 1)[0].slice(2).trim()
  if (!line) return null
  const parts = line.split(/\s+/)
  // THE `env` BINARY IS ITSELF AN INTERPRETER. This treated any path ending
  // `/env` as a working `env` and checked only the token after it, so
  // `#!/definitely/not/here/env sh` found `sh` on PATH and answered null while
  // the kernel fails on the missing `env`. A lane reproduced it — the fourth
  // iteration of this function, and the third where the fix covered the case I
  // pictured rather than the class.
  if (parts[0].endsWith('/env') && !executableCandidate(parts[0])) return parts[0]
  const interpreter = parts[0].endsWith('/env') && parts[1] ? parts[1] : parts[0]
  if (interpreter.includes('/')) {
    return executableCandidate(interpreter) ? null : interpreter
  }
  // A bare name goes through PATH — and this function IS given the PATH, so the
  // refusal that stood here was a hole wearing the words of a principle. Two
  // families raised it in three consecutive rounds, and the case they named,
  // `#!/usr/bin/env <missing>`, is the one the motivating comment used.
  //
  // With no PATH supplied there is genuinely nothing to resolve against, and
  // THAT is when saying nothing is honest.
  if (!pathValue) return null
  for (const dir of pathValue.split(delimiter)) {
    if (dir && executableCandidate(join(dir, interpreter))) return null
  }
  return interpreter
}

// Which executable a lane resolves to, and whether it can start. Only the agy
// lane resolves a binary parent-side; everything else routes through a wrapper
// this function does not own, so it answers null rather than guessing — a wrong
// specific answer is worse than none.
export function unresolvedInterpreterFor(id, { env = process.env } = {}) {
  if (id !== 'agy') return null
  const found = agyBinaryCandidates(env).find(executableCandidate)
  // `executablePath(env)`, NOT `env.PATH`. The child receives the PATH this
  // function builds — with `$HOME/.local/bin`, `$HOME/.kimi-code/bin` and
  // `$HOME/.bun/bin` prepended — so resolving against the caller's raw PATH
  // answered about a different machine state than the one the lane will run in.
  // A lane reproduced BOTH errors from it: a false `valid` when the interpreter
  // is only on the prepended path, and a false `unchecked` when it is only on
  // the caller's.
  return found ? shebangInterpreterMissing(found, { pathValue: executablePath(env) }) : null
}

function trustedAgyBinary(source) {
  const found = agyBinaryCandidates(source).find(executableCandidate)
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
    // Named locale variables only. This read `key.startsWith('LC_')`, so any
    // name a source invented — `LC_PRIVATE_TOKEN=<secret>` is the reviewer's
    // own example — rode into every profile, in a file whose opening lines
    // promise a profile-scoped environment with no ambient credential bag.
    // A prefix is not an allowlist.
    // Same rule as the credential check: a NUL-bearing value cannot reach a
    // child environment, so it is dropped here rather than thrown at spawn.
    if ((runtimeKeys.has(key) || POSIX_LOCALE_VARS.has(key)) && spawnableValue(String(value))) {
      env[key] = String(value)
    }
  }
  const path = executablePath(source)
  if (path) env.PATH = path
  if (ROUTED_PROFILES.has(profile.id)) Object.assign(env, loadRoutedEnvironment(profile, source, settingsLoader))
  const secretKeys = providerSecrets[profile.id]
  if (!Array.isArray(secretKeys)) {
    throw new TypeError(`profile ${profile.id} declares no provider-secret list — add one, empty if it forwards none`)
  }
  for (const key of secretKeys) {
    if (source?.[key] === undefined || source[key] === null) continue
    // EVERY value, not just the one credential that made the lane look usable.
    // `spawnableValue` was applied where we decide whether at least one accepted
    // credential exists, and nowhere on the way out — so a good
    // ANTHROPIC_AUTH_TOKEN beside a NUL-bearing ZAI_API_KEY gave
    // `configuration: "valid"` on an environment `spawnSync` refuses with
    // ERR_INVALID_ARG_VALUE. A lane reproduced exactly that pair; the previous
    // round's fix covered "one credential is usable", which is a different
    // sentence from "this environment can start a process".
    //
    // Omitted rather than thrown: a forwarded provider secret is optional by
    // construction, and the lane's own credential check already refuses when
    // nothing usable is left. Dropping it turns an unstartable child into a
    // legible credential refusal.
    env[key] = String(source[key])
  }
  if (profile.id === 'agy') {
    const agyBinary = agyBinaryResolver(source)
    if (!agyBinary) throw new TypeError('trusted agy executable not found')
    env.AGY_BIN = agyBinary
    env.AGY_SKIP_DOWNLOAD = '1'
  }
  if (ROUTED_PROFILES.has(profile.id) || profile.claudeExecutable || profile.id === 'claude') {
    // `requestModel` when the profile declares one. A lane reproduced the
    // mismatch: `deepseek` pins `requestModel: 'sonnet'` because that is the
    // alias its gateway answers to, while `profile.model` is the vendor's own
    // id `deepseek-v4-flash-0731` — so this advertised a model the gateway does
    // not take, in the one place the adapter reads to decide what to ask for.
    //
    // `model` stays the identity the panel records; `requestModel` is what the
    // wire is asked for. Two different questions that had one answer here.
    env.CLAUDE_MODEL_CONFIG = JSON.stringify({
      availableModels: [profile.requestModel ?? profile.model],
    })
  }
  // Set from the profile, never from the caller: `runtimeKeys` does not carry
  // this name, so the only way a lane can point the adapter at another Claude
  // binary is by declaring it here — which is what keeps a lane's family label
  // attached to something the gate chose.
  if (profile.claudeExecutable) env.CLAUDE_CODE_EXECUTABLE = profile.claudeExecutable
  if (Number.isSafeInteger(profile.thinkingBudgetTokens) && profile.thinkingBudgetTokens >= 0) {
    env.MAX_THINKING_TOKENS = String(profile.thinkingBudgetTokens)
  }
  // BEFORE the endpoint check, not after. A lane whose ONLY credential carried
  // a NUL had that credential rejected by `acceptedCredential` first, so the
  // answer was `credential_missing` — the exact "you already added it, the tool
  // says it is missing" outcome this check was added to prevent, still produced
  // by the check that prevents it, because it ran second.
  assertStartableEnvironment(profile.id, env)
  if (ROUTED_PROFILES.has(profile.id)) validateRoutedEndpoint(profile, env)
  return Object.freeze(env)
}

// A POLICY BUDGET, and the distinction cost a round. This machine spawns a
// 921,600-byte environment without complaint, so a refusal at 256 KiB is not a
// statement about what the OS will do — it is ours. The first version said
// "cannot start a process" for it, which was measurably false and is the kind
// of confident wrong sentence this repository has a rule about.
const ENVIRONMENT_BYTE_CEILING = 256 * 1024

// Linux caps a SINGLE argument or environment string at MAX_ARG_STRLEN, which
// is 32 pages — 131072 bytes on an ordinary 4 KiB-page kernel — INDEPENDENTLY
// of the total. So a 200 KiB credential fits under the total budget above and
// still fails with E2BIG on the CI host, where nothing here runs to notice.
// Unreproduced on this macOS box and taken on the reviewer's word plus the
// kernel constant, which is why the number is half the documented limit rather
// than equal to it.
const ENVIRONMENT_ENTRY_BYTE_CEILING = 64 * 1024

// ONE sweep over the FINAL environment, which is the only place that can answer
// "can this start a process". Two rounds of narrower fixes did not:
//
// - the first applied `spawnableValue` where we decide whether at least one
//   accepted credential exists, so a good token beside a NUL-bearing one gave
//   `configuration: "valid"` on an env `spawnSync` refuses;
// - the second applied it to the forwarded provider secrets, and a lane put the
//   same NUL in the routed SETTINGS file instead, which is assigned earlier and
//   was never in that loop.
//
// Both fixes were correct about the case they were shown. The property is about
// the finished object, so it is checked on the finished object.
//
// It THROWS rather than omitting. Omitting made a malformed supplied credential
// read as "missing", which sends an operator to add a credential they already
// added; a lane raised that as the wrong half of the trade.
// TWO refusals, because they are two different claims and one sentence was
// making both. A NUL byte means the environment CANNOT start a process — a
// fact, true on every platform. A size means we have DECIDED not to try — a
// policy, and saying "cannot start" about it was false on the machine that
// measured it.
//
// Both carry `code: 'config'` so `review-gate.mjs` reads them through
// `laneStage` as a deterministic stage and tells the operator to fix the
// profile. Without it a plain TypeError has no code, lands in `transport`, and
// the report says "re-run this lane alone" about a refusal that is identical on
// every attempt. And both carry `envKey`, so the repair can name the value that
// failed instead of pointing at a settings file that may not even hold it.
function assertStartableEnvironment(profileId, env) {
  let bytes = 0
  for (const [key, value] of Object.entries(env)) {
    const text = String(value)
    if (text.includes('\u0000')) {
      throw Object.assign(
        new TypeError(`${profileId} review environment cannot start a process: `
          + `${key} contains a NUL byte`),
        { code: 'config', envKey: key })
    }
    const entryBytes = Buffer.byteLength(key) + Buffer.byteLength(text) + 2
    if (entryBytes > ENVIRONMENT_ENTRY_BYTE_CEILING) {
      throw Object.assign(
        new TypeError(`${profileId} review environment is over budget: ${key} is `
          + `${entryBytes} bytes and the per-value ceiling is ${ENVIRONMENT_ENTRY_BYTE_CEILING}`),
        { code: 'config', envKey: key })
    }
    bytes += entryBytes
  }
  if (bytes > ENVIRONMENT_BYTE_CEILING) {
    throw Object.assign(
      new TypeError(`${profileId} review environment is over budget: it is ${bytes} `
        + `bytes and the ceiling is ${ENVIRONMENT_BYTE_CEILING}`),
      { code: 'config', envKey: null })
  }
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
