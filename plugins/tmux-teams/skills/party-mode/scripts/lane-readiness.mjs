// Is this machine able to run this plugin at all, and which lanes can it call?
//
// WHY THIS EXISTS, in the owner's words: "checking whether the plugin is ready
// to use, and what bins are available to call, still cannot be done at all —
// and when it is not ready, it must FORCE the setup process rather than letting
// an error be discovered later."
//
// THE GAP IS EXACT, AND THE CODE ALREADY ADMITS IT. `notProvenFor` in
// acp-lanes-mcp.mjs appends, for any lane declaring a wrapper, the sentence
// "that the wrapper `X` exists on PATH" — wrapper existence is ENUMERATED as
// something not proven rather than checked. `laneFacts` then returns
// `executable: profile.claudeExecutable ?? null`, echoing a name written in a
// shipped file without touching the disk.
//
// Measured 2026-08-29 on this machine: the `ninerouter` lane declares
// `claude-9r`, that binary does not exist here, and every lane-listing surface
// reported it beside working lanes with nothing to tell them apart.
//
// Be precise about what was already covered, because one lane WAS.
// `trustedAgyBinary` in review-profiles.mjs really does check the agy binary —
// it stats a fixed candidate list, requires a regular executable file, and
// resolves the shebang interpreter, and `buildProfileEnv` throws
// `trusted agy executable not found` when none passes. That check is
// hard-gated to `id === 'agy'`. So the hole is the OTHER five wrappers
// (`claude-kimi`, `claude-zai`, `claude-qwen` twice, `claude-9r`), plus
// `claude` and `codex`, which sit in `UNCHECKED_LANES` and have no
// parent-side check of any kind run against them.
//
// THE PATTERN IS THIS PLUGIN'S OWN, not a new invention. `graph-setup` is
// already "the mandatory first-run setup", and the loop runner "refuses to
// dispatch against it, and says so rather than idling silently" when the
// declaration is missing. That is status, gate, and exit — a light wired to a
// brake. This file applies the same three to lane executables, which had the
// light and no brake.
//
// CHEAP ON PURPOSE. Everything here is PATH resolution and `stat` — no spawn,
// no network, no provider quota. It answers "is the thing here", never "will it
// answer", which is what `acp_lane_probe` is for. Keeping that line sharp is
// what lets this run on every listing without an operator thinking about cost.
import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { applyLaneOverride } from './lane-overrides.mjs'

// The binaries the shipped scripts actually spawn, established by grepping
// every `spawn`/`spawnSync` call site rather than from memory. `tmux` is
// reached only from deliver.sh and is the transport the skill documents as the
// fallback, so it is required for the loop and not for a review lane.
export const PLUGIN_BINARIES = Object.freeze([
  { name: 'node', why: 'the companion, the dispatcher and the pulse writer all re-invoke node' },
  { name: 'git', why: 'worktrees, and every release and review path that reads a diff' },
  { name: 'npx', why: 'launches the ACP adapters that are node packages' },
  { name: 'bunx', why: 'launches the antigravity adapter, which is a native binary' },
  { name: 'tmux', why: 'the fallback transport for driving an interactive agent' },
])

// Closed vocabulary. A caller reads a CODE; nothing here is built from an
// environment value or a provider's wording, so a hostile PATH entry cannot
// place text in an operator's terminal through this file.
export const READINESS_PROBLEMS = Object.freeze({
  executable_absent: 'the executable this lane declares was not found on PATH',
  executable_not_file: 'the executable this lane declares resolves to something that is not a file',
  launcher_absent: 'the launcher this lane needs to start its adapter was not found on PATH',
  binary_absent: 'a binary this plugin invokes was not found on PATH',
})

/**
 * Resolve a command name against a PATH, without executing anything.
 * An absolute path is checked where it points; a bare name is searched.
 * Returns the resolved path, or null.
 */
export function resolveOnPath(command, env = process.env) {
  if (typeof command !== 'string' || command.length === 0) return null
  if (isAbsolute(command)) return existsSync(command) ? command : null
  const parts = String(env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of parts) {
    const candidate = join(dir, command)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const isFile = path => {
  try { return statSync(path).isFile() } catch { return false }
}

/**
 * Can this machine call this lane at all?
 *
 * Answers from the disk, never from the declaration. `blocking` is empty when
 * the lane is callable; every entry carries a closed `code` and the NAME of the
 * thing that is missing — a name the operator typed or that this repo ships,
 * never a value read out of the environment.
 */
export function laneAvailability(id, profile, env = process.env) {
  const blocking = []

  // The wrapper, when the lane declares one — the check that was absent for
  // every wrapper except agy's. `ninerouter` names `claude-9r` and this machine
  // does not have it.
  const wrapper = profile?.claudeExecutable
  if (wrapper) {
    const resolved = resolveOnPath(wrapper, env)
    if (!resolved) blocking.push({ code: 'executable_absent', missing: wrapper })
    else if (!isFile(resolved)) blocking.push({ code: 'executable_not_file', missing: wrapper })
  }

  // The launcher. Three of the eight lanes report `executable: null` today,
  // which reads as "needs nothing" and is false — they need `bunx` or `npx`,
  // declared in `command[0]`, where no listing surface was looking. Nothing
  // statically checks that the adapter PACKAGE that launcher would fetch is
  // resolvable either; that is named in `NOT_PROVEN` and only a live probe
  // exercises it, so it stays outside this file's claim.
  const launcher = Array.isArray(profile?.command) ? profile.command[0] : null
  if (launcher && !resolveOnPath(launcher, env)) {
    blocking.push({ code: 'launcher_absent', missing: launcher })
  }

  return {
    lane: id,
    available: blocking.length === 0,
    blocking: Object.freeze(blocking),
    // Named so a caller can show what a lane runs WITHOUT re-deriving it, and
    // so `executable: null` stops meaning two different things.
    needs: Object.freeze([launcher, wrapper].filter(Boolean)),
  }
}

/**
 * Is the plugin itself usable on this machine, before any lane is considered?
 *
 * A missing `node` is not a lane problem and must not be reported as eight lane
 * problems — an operator reading eight identical failures goes looking in the
 * wrong place.
 */
export function pluginReadiness(env = process.env) {
  const missing = PLUGIN_BINARIES
    .filter(b => !resolveOnPath(b.name, env))
    .map(b => ({ code: 'binary_absent', missing: b.name, why: b.why }))
  return {
    ready: missing.length === 0,
    missing: Object.freeze(missing),
    checked: Object.freeze(PLUGIN_BINARIES.map(b => b.name)),
  }
}

/**
 * The whole picture, and the one thing a caller has to read before dispatching.
 *
 * `setupRequired` is the GATE. It is true whenever the plugin is short a binary
 * or every lane is uncallable — the states where proceeding produces an error
 * later instead of an answer now. A caller that dispatches anyway is choosing
 * to, rather than not having been told.
 */
export function readinessReport(profiles, env = process.env, {
  overrideLoader = null,
} = {}) {
  const plugin = pluginReadiness(env)
  // APPLY THE PER-MACHINE OVERRIDES FIRST. Readiness read the shipped profiles
  // and nothing else until a round-trip caught it: setting an override wrote
  // the file, and the re-check went on reporting the shipped executable as
  // missing. That is a setting that looks applied and is not — the exact
  // failure this release exists to end, reproduced by the release itself.
  // The loader is injected so a test can drive it without writing to a home
  // directory, and defaults to null so a caller with no per-machine file (the
  // overwhelmingly common case) pays nothing.
  const overrides = overrideLoader
    ? (overrideLoader({ knownLanes: Object.keys(profiles), env })?.overrides ?? {})
    : {}
  const lanes = Object.entries(profiles).map(([id, p]) =>
    laneAvailability(id, applyLaneOverride(p, overrides[id], env), env))
  const callable = lanes.filter(l => l.available)
  return {
    plugin,
    lanes: Object.freeze(lanes),
    callableLanes: Object.freeze(callable.map(l => l.lane)),
    setupRequired: !plugin.ready || callable.length === 0,
    // A review panel needs three distinct families. Reporting "two lanes work"
    // without that is a number an operator cannot act on.
    callableFamilies: Object.freeze([...new Set(
      callable.map(l => profiles[l.lane]?.family).filter(Boolean))]),
  }
}
