// Per-machine lane configuration — v0.36 part two.
//
// WHY THIS EXISTS. Every entry in `REVIEW_PROFILES` hardcodes three things that
// are facts about a MACHINE rather than about a lane: the launcher (`bunx` or
// `npx -y`), the pinned adapter package, and the wrapper executable's name. The
// v0.35.0 release measured seven lane failures on one machine and four of them
// lived in exactly that layer — an npm cache resolving to a removable volume
// with a truncated install, a wrapper needing its own config directory, a model
// value the adapter did not advertise, and one lane that worked only because
// its launcher happened to be a native binary. None was a code defect, and none
// could be fixed without editing a file this plugin ships.
//
// WHERE IT LIVES, and why not beside the plugin. A plugin install is
// version-keyed — `~/.claude/plugins/cache/tmux-teams/tmux-teams/<version>/` —
// so a file written there is destroyed by the next `claude plugin update`,
// which is precisely the moment an operator most needs their machine's settings
// to survive. It lives under the user's own config directory instead and
// outlives every upgrade.
//
// FAIL CLOSED, LOUDLY. A file that cannot be parsed does NOT fall back to the
// shipped defaults in silence. An operator who wrote an override is telling us
// the shipped default does not work here; running it anyway reproduces their
// original failure while the fix appears to be applied, which is worse than
// refusing outright. Absence is a different thing from malformed: no file at
// all is the ordinary case and is not a problem.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const OVERRIDE_DIR = join(homedir(), '.config', 'tmux-teams')
export const OVERRIDE_PATH = join(OVERRIDE_DIR, 'lanes.json')

// The path RESOLVED AGAINST A GIVEN ENVIRONMENT, not against the process's own
// home. The constants above are computed once at import from `homedir()`, which
// made every caller read the developer's real home no matter what environment
// it was handed — a server that is given an `env` and ignores it, and a test
// whose result depends on whose machine runs it. Found when a leftover override
// file from a manual reproduction turned a passing guard red.
export function overridePathFor(env = process.env) {
  const home = env?.HOME ?? env?.USERPROFILE
  return home ? join(home, '.config', 'tmux-teams', 'lanes.json') : OVERRIDE_PATH
}

// A CLOSED set. A field outside it is REFUSED rather than ignored, because an
// ignored typo is a setting the operator believes is in effect and is not —
// the exact shape of failure this whole feature exists to end.
export const OVERRIDABLE_FIELDS = Object.freeze([
  'command',
  'claudeExecutable',
  'adapterPackage',
  'model',
  'env',
])

// Closed diagnostic vocabulary, the same discipline as the lane-probe codes: a
// caller reads a CODE, never a sentence built from the file's bytes. Nothing
// derived from the file's CONTENT appears in any of these strings, so a
// malformed override cannot smuggle provider text into an operator's terminal.
export const OVERRIDE_PROBLEMS = Object.freeze({
  unreadable: 'the per-machine lane override file exists but could not be read',
  not_json: 'the per-machine lane override file is not valid JSON',
  not_object: 'the per-machine lane override file must hold a JSON object at its top level',
  unknown_lane: 'the override file names a lane this plugin does not ship',
  lane_not_object: 'an override entry must be a JSON object',
  unknown_field: 'an override entry sets a field that is not overridable',
  bad_command: 'an override command must be a non-empty array of strings',
  bad_env: 'an override env must be an object whose keys and values are all strings',
  bad_string: 'an override field must be a non-empty string',
  bad_adapter_swap: 'this lane cannot take an adapterPackage override — its launch command does not name the package it declares',
})

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Read and validate the per-machine override file.
 *
 * Returns `{ overrides, problems, present }`. Every `problems[].code` is a key
 * of `OVERRIDE_PROBLEMS` and nothing else. When `problems` is non-empty,
 * `overrides` is EMPTY — a file applies whole or not at all, so one bad line
 * cannot leave a caller half-configured and unaware of which half took.
 */
export function loadLaneOverrides({
  knownLanes,
  // The shipped profiles, when a caller has them. Only ONE check needs them and
  // it is the one that stops a silent no-op: see `bad_adapter_swap` below.
  profiles = null,
  env,
  path = env ? overridePathFor(env) : OVERRIDE_PATH,
  readFile = readFileSync,
} = {}) {
  const known = new Set(knownLanes ?? [])
  let raw
  try {
    raw = readFile(path, 'utf8')
  } catch (error) {
    // ENOENT is the ordinary case — most machines never write this file — and
    // is not a problem. Anything else (a permission error, a directory where a
    // file belongs) IS one: the operator meant something to be there.
    if (error?.code === 'ENOENT') return { overrides: {}, problems: [], present: false }
    return { overrides: {}, problems: [{ code: 'unreadable', lane: null, field: null }], present: true }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { overrides: {}, problems: [{ code: 'not_json', lane: null, field: null }], present: true }
  }
  if (!isPlainObject(parsed)) {
    return { overrides: {}, problems: [{ code: 'not_object', lane: null, field: null }], present: true }
  }

  const problems = []
  const overrides = {}
  for (const [lane, entry] of Object.entries(parsed)) {
    if (!known.has(lane)) { problems.push({ code: 'unknown_lane', lane, field: null }); continue }
    if (!isPlainObject(entry)) { problems.push({ code: 'lane_not_object', lane, field: null }); continue }
    const clean = {}
    for (const [field, value] of Object.entries(entry)) {
      if (!OVERRIDABLE_FIELDS.includes(field)) {
        problems.push({ code: 'unknown_field', lane, field }); continue
      }
      if (field === 'command') {
        if (!Array.isArray(value) || value.length === 0 || !value.every(v => typeof v === 'string' && v.length > 0)) {
          problems.push({ code: 'bad_command', lane, field }); continue
        }
        clean.command = Object.freeze([...value])
      } else if (field === 'env') {
        if (!isPlainObject(value)
          || !Object.entries(value).every(([k, v]) => typeof k === 'string' && typeof v === 'string')) {
          problems.push({ code: 'bad_env', lane, field }); continue
        }
        clean.env = Object.freeze({ ...value })
      } else {
        if (typeof value !== 'string' || value.length === 0) {
          problems.push({ code: 'bad_string', lane, field }); continue
        }
        clean[field] = value
      }
    }
    // AN OVERRIDE THAT CANNOT TAKE EFFECT IS REFUSED, NOT IGNORED. The package
    // that launches lives in `command`; substituting it works only when the
    // command names the shipped package verbatim. A lane whose command does not
    // — a native-binary lane, or one that names no package at all — would have
    // accepted the field, changed a declaration, and gone on launching the old
    // package. A deepseek review lane found that this file's own comment
    // promised this refusal while nothing implemented it.
    if (clean.adapterPackage && profiles) {
      const shipped = profiles[lane]
      const command = Array.isArray(shipped?.command) ? shipped.command : []
      if (!shipped?.adapterPackage || !command.includes(shipped.adapterPackage)) {
        problems.push({ code: 'bad_adapter_swap', lane, field: 'adapterPackage' })
        continue
      }
    }
    overrides[lane] = Object.freeze(clean)
  }

  // Whole or nothing. Half-applying a file the operator got wrong is how a
  // setting comes to look applied while the original failure carries on.
  if (problems.length > 0) return { overrides: {}, problems, present: true }
  return { overrides: Object.freeze(overrides), problems: [], present: true }
}

/**
 * Layer one lane's override onto its shipped profile. The shipped profile is
 * never mutated; a new frozen profile comes back.
 *
 * `env` MERGES rather than replaces, and the override LOSES to anything already
 * in the process environment — an operator debugging with `FOO=bar` in front of
 * a command expects that to beat a file they edited last week, and every lane
 * failure in v0.35.0 was in fact diagnosed exactly that way.
 */
export function applyLaneOverride(profile, override, processEnv = {}) {
  if (!override || Object.keys(override).length === 0) return profile
  const next = { ...profile }
  for (const field of OVERRIDABLE_FIELDS) {
    if (field === 'env' || !(field in override)) continue
    next[field] = override[field]
  }
  // `adapterPackage` alone changes NOTHING that runs: the package that actually
  // launches lives in `command`, and `assertAdapterPackageBoundToCommand`
  // requires the two to agree. An openai review lane found that an operator
  // could set the field, be told the lane was callable, and still launch the
  // shipped package — a setting that looks applied and is not, which is the
  // defect shape this whole release exists to end.
  //
  // So the package is substituted INTO the command, in the one argument that
  // carries it. If no argument matches the shipped package the override is
  // refused at load rather than applied silently — see `bad_adapter_swap`.
  if (override.adapterPackage && Array.isArray(next.command)) {
    const shipped = profile.adapterPackage
    next.command = Object.freeze(next.command.map(
      arg => (arg === shipped ? override.adapterPackage : arg)))
  }
  if (override.env) {
    const merged = { ...override.env }
    for (const key of Object.keys(merged)) {
      if (Object.hasOwn(processEnv, key)) merged[key] = processEnv[key]
    }
    next.overrideEnv = Object.freeze(merged)
  }
  return Object.freeze(next)
}
