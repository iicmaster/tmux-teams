#!/usr/bin/env node
// An MCP server that answers ONE question: which ACP review lanes exist here,
// and what does each one still need on THIS machine.
//
// Why it exists. The per-machine half of the ACP problem was solved in code on
// 2026-08-13 — `TMUX_TEAMS_REVIEW_<ID>_SETTINGS` and
// `TMUX_TEAMS_REVIEW_<ID>_ENV_FILE` let a profile live anywhere — and then
// nothing told anybody. The answer to "why does my lane refuse" was "read the
// comment at review-profiles.mjs:627", which is a document, not an answer.
// A tool that answers beats a document that could be read.
//
// Three lines it does not cross:
//
//   ADR 0003 stands. A DISPATCHED agent receives no MCP server, enforced at
//   runtime and asserted by the suite. This server is for the operator driving
//   the plugin, which is a different surface, and nothing here weakens that.
//
//   It never returns a credential. It does not read one either: readiness is
//   decided by handing the work to `buildAcpLaunch` and reporting whether it
//   complained, so a secret never enters this process's own answer at all.
//   `buildAcpLaunch` builds an env that CONTAINS the token — that object is
//   deliberately never touched here beyond being discarded.
//
//   It is read-only. No tool dispatches, spawns a lane, or starts a review.
//   Discovery only, for the same reason a reviewer lane cannot launch delivery
//   work.

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REVIEW_PROFILES, ROUTED_PROFILES, buildAcpLaunch } from './review-profiles.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..', '..', '..')

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

// Readiness, decided by the same function a real run uses. Anything else would
// be a second reader of the same question, which this repository has paid for
// before: two readers disagree, and the one nobody runs is the one that lies.
export function laneStatus(id, profile, env) {
  const names = overrideNames(id)
  try {
    buildAcpLaunch(id, { env })
    return { ...laneFacts(id, profile), ready: true, problem: null, fixes: [] }
  } catch (error) {
    const problem = String(error?.message ?? error)
    const fixes = []
    if (profile.settingsRelativePath) {
      fixes.push(`place the lane's settings JSON at $HOME/${profile.settingsRelativePath}`)
      fixes.push(`or point ${names.settings} at wherever this machine keeps it`)
    }
    if (ROUTED_PROFILES.has(id)) {
      fixes.push(`if the credential lives outside that JSON, point ${names.credentials} at the env file holding it`)
    }
    return { ...laneFacts(id, profile), ready: false, problem, fixes }
  }
}

const TOOLS = [
  {
    name: 'acp_lanes',
    description: 'List every ACP review lane this plugin declares: family, provider, model, '
      + 'adapter package, and whether the lane is pinned to a verified endpoint. Declared facts only '
      + '— it touches nothing on this machine and can answer with no configuration present.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'acp_lane_status',
    description: 'Say whether a lane can actually run on THIS machine, and when it cannot, what is '
      + 'missing and which environment variable points at it. Never returns a credential or a '
      + 'credential value. Read-only: it starts nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', description: 'One lane id. Omit to report every lane.' },
      },
      additionalProperties: false,
    },
  },
]

export function callTool(name, args, env) {
  if (name === 'acp_lanes') {
    return { lanes: Object.entries(REVIEW_PROFILES).map(([id, profile]) => laneFacts(id, profile)) }
  }
  if (name === 'acp_lane_status') {
    const wanted = args?.lane
    if (wanted !== undefined && !Object.hasOwn(REVIEW_PROFILES, wanted)) {
      return { error: `no such lane: ${wanted}`, known: Object.keys(REVIEW_PROFILES) }
    }
    const ids = wanted === undefined ? Object.keys(REVIEW_PROFILES) : [wanted]
    return { lanes: ids.map((id) => laneStatus(id, REVIEW_PROFILES[id], env)) }
  }
  return { error: `no such tool: ${name}` }
}

export function handle(message, env = process.env) {
  const { id, method, params } = message ?? {}
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'tmux-teams-acp-lanes', version: pluginVersion() },
      },
    }
  }
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

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) serve()
