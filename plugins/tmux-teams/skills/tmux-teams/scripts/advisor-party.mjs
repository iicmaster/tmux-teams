#!/usr/bin/env node
// Seat a saved bmad-party-mode roster in an advisor brief.
//
//   node advisor-party.mjs <party-id> [--project-root <dir>]
//
// Prints the paragraph that REPLACES the "Cast 3-5 named voices" line in a
// `*-advisor` brief, so the lane answers as the operator's own saved party —
// the same `--party <id>` that bmad-party-mode itself takes — instead of
// inventing a cast per run. Every `*-advisor` skill shells to this file, so the
// three of them cannot drift apart on how a roster is rendered.
//
// It exits `2` with a sentence when the party cannot be honoured, and it never
// falls back to the invented cast on its own: an operator who typed `--party`
// asked for a specific room, and quietly running a different one is the same
// silent substitution this plugin refuses everywhere else. The SKILL that
// called this decides what to do with a refusal; this file only refuses.
//
// The resolver is bmad-party-mode's own `resolve_party.py`, run through `uv`.
// bmad-party-mode is a separate install and is NOT shipped by this plugin, so
// its absence is an ordinary outcome here, reported as `not_installed`.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PARTY_PROBLEMS = Object.freeze({
  not_installed: 'bmad-party-mode is not installed at the expected root, so no saved party can be seated',
  uv_missing: 'uv is not on PATH, and bmad-party-mode resolves its rosters through uv',
  unknown_party: 'no saved party has that id',
  resolver_failed: 'the party resolver ran and did not return a roster',
})

export function partyModeRoot(env = process.env) {
  return env.BMAD_PARTY_MODE_ROOT || join(env.HOME ?? homedir(), '.claude', 'skills', 'bmad-party-mode')
}

/**
 * Resolve a party id to bmad-party-mode's own JSON. Returns
 * `{ ok: true, party }` or `{ ok: false, code, available }`.
 * `run` is injectable so a test never needs uv or a real install.
 */
export function resolveParty(id, { env = process.env, projectRoot = process.cwd(), run = spawnSync } = {}) {
  const root = partyModeRoot(env)
  const script = join(root, 'scripts', 'resolve_party.py')
  if (!existsSync(script)) return { ok: false, code: 'not_installed', available: [] }
  const r = run('uv', ['run', script, '--project-root', projectRoot, '--skill', root, '--party', id],
    { encoding: 'utf8', env })
  if (r.error?.code === 'ENOENT') return { ok: false, code: 'uv_missing', available: [] }
  let parsed
  try { parsed = JSON.parse(r.stdout ?? '') } catch { return { ok: false, code: 'resolver_failed', available: [] } }
  if (parsed?.error === 'unknown_group') {
    return { ok: false, code: 'unknown_party', available: (parsed.available ?? []).map(g => g.id) }
  }
  if (!Array.isArray(parsed?.members) || parsed.members.length === 0) {
    return { ok: false, code: 'resolver_failed', available: [] }
  }
  return { ok: true, party: parsed }
}

/**
 * The paragraph that goes into the brief. Pure, so a test can hold it to a
 * fixture. Real names and titles only — an advisor that renames a saved voice
 * has thrown away the reason a saved party exists.
 */
export function renderPartyMandate(party) {
  const cast = party.members.map(m => {
    const head = `${m.icon ? `${m.icon} ` : ''}${m.name} — ${m.title}`
    const body = [m.persona, m.capabilities].filter(Boolean).join(' ')
    return body ? `- ${head}: ${body}` : `- ${head}`
  }).join('\n')
  const scene = party.scene ? `\nScene: ${party.scene}\n` : '\n'
  return [
    `Answer as a bmad-party-mode round-table using EXACTLY this cast, the saved party "${party.name}" (${party.active}). Every voice below speaks, under its own name and title; add no one and rename no one.`,
    cast,
    scene.trimEnd(),
    'They address each other, not only me, and they disagree where their lenses genuinely differ. Do not resolve the clash into consensus; where they cannot agree, say so and say why. End with each voice\'s own bottom line. State plainly whatever you could not verify.',
  ].join('\n\n')
}

export function main(argv, { env = process.env, out = console.log, err = console.error, run = spawnSync } = {}) {
  const args = [...argv]
  let projectRoot = process.cwd()
  const i = args.indexOf('--project-root')
  if (i !== -1) { projectRoot = args[i + 1]; args.splice(i, 2) }
  const id = args[0]
  if (!id || id.startsWith('-')) {
    err('usage: node advisor-party.mjs <party-id> [--project-root <dir>]')
    return 1
  }
  const result = resolveParty(id, { env, projectRoot, run })
  if (!result.ok) {
    err(`${result.code}: ${PARTY_PROBLEMS[result.code]}`)
    if (result.available.length) err(`available: ${result.available.join(', ')}`)
    return 2
  }
  out(renderPartyMandate(result.party))
  return 0
}

const { realpathSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const { resolve } = await import('node:path')
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])) } catch { return false }
})()
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
