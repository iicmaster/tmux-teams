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
//   - No reply carries a credential, its value, or its field name. Tested by
//     serialising whole replies built from secret-bearing fixtures, on the
//     success path AND on the failure paths.
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
// Tools and their handlers come from ONE descriptor list, so a handler that is
// not advertised cannot exist. The earlier test scanned advertised names for
// action verbs, which a hidden branch in the dispatcher would have walked past.

import { readFileSync, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REVIEW_PROFILES, ROUTED_PROFILES, buildAcpLaunch } from './review-profiles.mjs'

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
export const DIAGNOSTICS = Object.freeze({
  endpoint_missing: 'the lane is pinned to an endpoint and this machine supplies no base URL for it',
  endpoint_mismatch: 'the base URL configured here is not the endpoint this lane is pinned to',
  credential_missing: 'the endpoint is configured but no provider credential was found for it',
  settings_unreadable: 'the settings this lane points at are not a readable JSON object',
  executable_missing: 'an executable this lane needs was not found on this machine',
  unclassified: 'the lane refused for a reason this server does not classify; run the gate for the detail',
})

// Classification reads the exception and keeps only which BUCKET it fell into.
// Nothing derived from the message text survives this function.
export function classify(message) {
  const text = String(message ?? '')
  if (/requires ANTHROPIC_BASE_URL/.test(text)) return 'endpoint_missing'
  if (/endpoint must be|must be a valid URL/.test(text)) return 'endpoint_mismatch'
  if (/explicit provider credential/.test(text)) return 'credential_missing'
  if (/must be a JSON object|pins no endpoint/.test(text)) return 'settings_unreadable'
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

// Every fix this server can offer for a lane, whatever went wrong. The first
// version built this only from `settingsRelativePath`, so `agy` — which has no
// settings file and fails on a missing binary — was answered with an empty list
// by a tool whose whole promise is to say what is missing.
export function fixesFor(id, profile, code) {
  const names = overrideNames(id)
  const out = []
  if (profile.settingsRelativePath) {
    out.push(`place this lane's settings JSON at $HOME/${profile.settingsRelativePath}`)
    out.push(`or point ${names.settings} at wherever this machine keeps it`)
  }
  if (ROUTED_PROFILES.has(id)) {
    out.push(`if the credential lives outside that JSON, point ${names.credentials} at the env file holding it`)
  }
  if (profile.claudeExecutable) {
    out.push(`the wrapper ${profile.claudeExecutable} must exist on PATH and select this provider`)
  }
  if (Array.isArray(profile.command) && profile.command.length) {
    out.push(`the adapter this lane launches (${profile.command.join(' ')}) must resolve on this machine`)
  }
  return out
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
      notProven: NOT_PROVEN,
      note: 'no parent-side configuration check exists for this lane, so nothing here was verified',
    }
  }
  try {
    // The object this returns CONTAINS the credential. It is bound to nothing
    // and referenced nowhere, which is the whole of what "never returned" means.
    buildAcpLaunch(id, { env })
    return { ...facts, configuration: 'valid', problem: null, fixes: [], notProven: NOT_PROVEN }
  } catch (error) {
    const code = classify(error?.message)
    return {
      ...facts,
      configuration: 'invalid',
      problem: { code, detail: DIAGNOSTICS[code] },
      fixes: fixesFor(id, profile, code),
      notProven: NOT_PROVEN,
    }
  }
}

// ONE list. `TOOLS` and the dispatcher are both derived from it, so an
// unadvertised handler is not something a reviewer has to go looking for — it
// is unrepresentable.
export const TOOL_DESCRIPTORS = Object.freeze([
  {
    name: 'acp_lanes',
    description: 'List every ACP review lane this plugin declares: family, provider, model, '
      + 'adapter package, and whether the lane is pinned to a verified endpoint. Declared facts only '
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
        return { error: `no such lane: ${wanted}`, known: Object.keys(REVIEW_PROFILES) }
      }
      const ids = wanted === undefined ? Object.keys(REVIEW_PROFILES) : [wanted]
      return { lanes: ids.map((id) => laneStatus(id, REVIEW_PROFILES[id], env)) }
    },
  },
])

export const TOOLS = Object.freeze(TOOL_DESCRIPTORS.map(({ handler, ...rest }) => rest))
const HANDLERS = new Map(TOOL_DESCRIPTORS.map((d) => [d.name, d.handler]))

export function callTool(name, args, env) {
  const handler = HANDLERS.get(name)
  if (!handler) return { error: `no such tool: ${name}`, known: [...HANDLERS.keys()] }
  return handler(args, env)
}

export function handle(message, env = process.env) {
  const { id, method, params } = message ?? {}
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
    const payload = callTool(params?.name, params?.arguments, env)
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: Boolean(payload?.error),
      },
    }
  }
  // A notification carries no id and gets no reply, which is the protocol and
  // also the difference between a quiet server and one that answers a message
  // nobody asked a question with.
  if (id === undefined || id === null) return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
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
        jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' },
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
