// What model will this lane ACTUALLY call?
//
// WHY THIS EXISTS, and it is the question that cost the most time in v0.35.0.
// The `qwen` lane is requested with the alias `opus`. On this machine that
// gateway maps `opus` to `deepseek-v4-pro-0813`, so a panel recorded as
// "qwen" was answered by deepseek — and the only way anyone found out was
// opening the wrapper's settings file by hand. Two lanes can share one gateway
// and answer as different families; an alias alone cannot tell them apart, and
// the release record depends on telling them apart.
//
// FREE, AND HONEST ABOUT WHAT IT CANNOT SEE. This reads a JSON file. It sends
// no prompt, contacts no endpoint and spends no quota, so it can run on every
// listing. What a file cannot answer, it reports as `unknown` — never as a
// guess. A lane whose gateway resolves aliases server-side is genuinely
// unknowable from here, and saying so is the whole point: this repository has
// spent a release deleting confident answers that outran their evidence.
//
// NEVER READS A SECRET. The settings files these lanes point at carry
// `ANTHROPIC_AUTH_TOKEN` beside the model aliases. Only the three
// `ANTHROPIC_DEFAULT_*_MODEL` keys are ever read out of them, by name, and
// nothing else in the file is copied, returned or logged.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The three keys, named exhaustively. A prefix match would pick up
// `ANTHROPIC_AUTH_TOKEN` the day someone renames it, and a token that reaches a
// listing is a token on a screen.
export const ALIAS_KEYS = Object.freeze({
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
})

export const MODEL_SOURCES = Object.freeze({
  declared: 'the model this profile declares, with no machine evidence behind it',
  alias_resolved: 'the alias this lane requests, resolved through this machine settings file',
  unknown: 'this machine cannot say what this lane resolves to without asking the provider',
})

const readAliases = (relativePath, home) => {
  if (!relativePath) return null
  try {
    const parsed = JSON.parse(readFileSync(join(home, relativePath), 'utf8'))
    const env = parsed?.env
    if (!env || typeof env !== 'object') return null
    // By NAME, one at a time. Nothing else in this object is touched.
    const out = {}
    for (const [alias, key] of Object.entries(ALIAS_KEYS)) {
      if (typeof env[key] === 'string' && env[key].length > 0) out[alias] = env[key]
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    // Unreadable, absent, or not JSON. All three mean the same thing to a
    // caller — this machine cannot answer — and none of them is worth a
    // distinct code here, because the settings CHECK in acp_lane_status
    // already reports why a settings file failed.
    return null
  }
}

/**
 * What this lane will request, and what that resolves to here.
 *
 * `requested` is the string that actually goes on the wire — `requestModel`
 * when the profile declares one, because a lane reproduced the mismatch:
 * `deepseek` records the identity `deepseek-v4-flash-0731` while requesting the
 * alias `sonnet`.
 *
 * `resolved` is what this machine's settings map that alias to, or null.
 * `source` says which of those two a caller is looking at, so a declaration is
 * never mistaken for evidence.
 */
export function laneModel(id, profile, { home = homedir() } = {}) {
  const declared = profile?.model ?? null
  const requested = profile?.requestModel ?? declared
  const aliases = readAliases(profile?.settingsRelativePath, home)
  const resolved = aliases && typeof requested === 'string' ? (aliases[requested] ?? null) : null

  return {
    lane: id,
    declared,
    requested,
    resolved,
    // A profile with no settings file cannot be resolved from disk at all; one
    // WITH a settings file that does not map this alias is a different state
    // and is reported as such, because the repairs differ.
    source: resolved ? 'alias_resolved' : (declared ? 'declared' : 'unknown'),
    detail: resolved ? MODEL_SOURCES.alias_resolved : (declared ? MODEL_SOURCES.declared : MODEL_SOURCES.unknown),
    // Named so a caller can see WHICH aliases this machine defines without
    // having to open the file — the fact that `opus` and `sonnet` point at
    // different families on one gateway is the thing worth seeing.
    aliasesOnThisMachine: aliases ? Object.freeze({ ...aliases }) : null,
  }
}

export function laneModels(profiles, options = {}) {
  return Object.entries(profiles).map(([id, p]) => laneModel(id, p, options))
}
