#!/usr/bin/env node
// tmux-teams-setup.mjs — check and bootstrap free prerequisites for tmux-teams
// (`bmad-method`, `@opencode/cli`, `bmad-party-mode`, Python runtime) and
// inspect installed plugin cache versions read-only.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, accessSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OPENCODE_PACKAGE_NAME,
  OPENCODE_PACKAGE_SPEC,
  OPENCODE_RESOLVED_VERSION,
  buildOpencodeProfile,
  cleanGateNpmEnv,
  inspectOpencodeCache,
  parseOpencodeVersion,
} from '../../tmux-teams/scripts/opencode-execution-profile.mjs'
import { buildSafePythonEnv, parsePythonVersion } from '../../tmux-teams/scripts/advisor-party.mjs'
import { pluginReadiness } from '../../party-mode/scripts/lane-readiness.mjs'
import { buildProfileEnv, executablePath } from '../../party-mode/scripts/review-profiles.mjs'
import { resolveExecutableSync } from '../../party-mode/scripts/acp-review-client.mjs'

export const BMAD_METHOD_SPEC = 'bmad-method@6.12.4'
export const OPENCODE_SPEC = OPENCODE_PACKAGE_SPEC
export const OPENCODE_VERSION = OPENCODE_RESOLVED_VERSION
export const OPENCODE_AUTH_DISPLAY_PATH = '~/.local/share/opencode/auth.json'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = resolve(HERE, '..', '..', '..')
const MAX_AUTH_BYTES = 64 * 1024
const KEY_CACHE_PROBE_FILES = Object.freeze([
  'skills/tmux-teams-setup/scripts/tmux-teams-setup.mjs',
  'skills/party-mode/scripts/review-policy.mjs',
  'skills/party-mode/scripts/review-profiles.mjs',
  'skills/party-mode/scripts/review-gate.mjs',
  'skills/tmux-teams/scripts/acp-companion.mjs',
  'skills/tmux-teams/scripts/opencode-execution-profile.mjs',
])

export const SETUP_PROBLEMS = Object.freeze({
  node_missing: 'Node.js runtime is missing',
  node_too_old: 'Node.js >= 20 is required',
  git_missing: 'git binary is missing from PATH',
  npx_missing: 'npx binary is missing from PATH',
  uv_missing: 'uv is not installed (non-blocking while python3 >= 3.11 is present)',
  python_runtime_missing: 'neither uv nor python3 >= 3.11 is available on PATH for bmad-party-mode',
  bmad_missing: 'BMAD installation (_bmad or bmad-party-mode) was not found',
  bmad_party_missing: 'global ~/.claude/skills/bmad-party-mode is missing',
  opencode_missing: `verified ${OPENCODE_PACKAGE_SPEC} install is missing from the effective npm _npx slot`,
  opencode_version_drift: `installed OpenCode version does not match pinned ${OPENCODE_PACKAGE_SPEC}`,
  opencode_custom_npx_shim: 'gate PATH resolves npx to a custom shim outside the npm installation; npm _npx cache metadata does not prove what the review gate launches',
  opencode_launcher_untrusted: 'gate executable resolver refused npx (outside trusted runtime roots, inside target repository, or non-executable)',
  opencode_prefix_unverified: 'failed to determine npm global prefix from paired npm; cannot rule out a global opencode install overriding _npx cache',
  opencode_auth_key_present: `non-blocking warning: ${OPENCODE_AUTH_DISPLAY_PATH} has stored credential entries (free OpenCode seats run keyless; expired keys fail turns)`,
  opencode_auth_invalid: `non-blocking warning: ${OPENCODE_AUTH_DISPLAY_PATH} is unreadable or invalid JSON`,
  unsafe_project_root: 'refusing unsafe --project-root (must not be /, $HOME, or inside plugins/tmux-teams)',
  plugin_cache_stale: 'one or more local tmux-teams plugin caches have a stale plugin version',
  plugin_cache_drifted: 'one or more local tmux-teams plugin caches differ from bundled plugin scripts',
  install_failed: 'an installation step exited non-zero',
  profile_write_failed: 'failed to write closed opencode-execution-profile JSON',
})

function canonicalForContainment(target) {
  const abs = resolve(target)
  const parts = []
  let probe = abs
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    parts.unshift(probe.slice(parent === parse(parent).root ? parent.length : parent.length + 1))
    probe = parent
  }
  let base = probe
  try { base = realpathSync(probe) } catch { base = probe }
  return parts.length ? join(base, ...parts) : base
}

/**
 * Refuse dangerous install/project targets (`/`, `$HOME`, `USERPROFILE`, or
 * anything inside the bundled `plugins/tmux-teams` plugin tree).
 */
export function isUnsafeProjectRoot(dir, { env = process.env, pluginRoot = PLUGIN_ROOT } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) return true
  const canonical = canonicalForContainment(dir)
  if (canonical === parse(canonical).root) return true

  const blockedExact = new Set()
  for (const candidate of [homedir(), env?.HOME, env?.USERPROFILE]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      blockedExact.add(resolve(candidate))
      blockedExact.add(canonicalForContainment(candidate))
    }
  }
  if (blockedExact.has(resolve(dir)) || blockedExact.has(canonical)) return true

  const resolvedPlugin = canonicalForContainment(pluginRoot)
  if (canonical === resolvedPlugin || canonical.startsWith(resolvedPlugin + sep)) return true
  return false
}

/**
 * Inspect OpenCode `auth.json` under ADR-0007 secret containment: returns only
 * closed codes and a constant display path — never raw JSON error messages,
 * resolved symlink targets, or key material.
 */
export function inspectOpencodeAuth(env = process.env) {
  const home = env?.HOME || env?.USERPROFILE || homedir()
  const dataHome = env?.XDG_DATA_HOME || join(home, '.local', 'share')
  const authPath = join(dataHome, 'opencode', 'auth.json')
  if (!existsSync(authPath)) {
    return Object.freeze({ status: 'absent', problem: null, path: OPENCODE_AUTH_DISPLAY_PATH })
  }
  let st
  try {
    st = lstatSync(authPath)
  } catch {
    return Object.freeze({ status: 'invalid', problem: 'opencode_auth_invalid', path: OPENCODE_AUTH_DISPLAY_PATH })
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_AUTH_BYTES) {
    return Object.freeze({ status: 'invalid', problem: 'opencode_auth_invalid', path: OPENCODE_AUTH_DISPLAY_PATH })
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(authPath, 'utf8'))
  } catch {
    return Object.freeze({ status: 'invalid', problem: 'opencode_auth_invalid', path: OPENCODE_AUTH_DISPLAY_PATH })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.freeze({ status: 'invalid', problem: 'opencode_auth_invalid', path: OPENCODE_AUTH_DISPLAY_PATH })
  }
  const hasEntries = Object.keys(parsed).length > 0
  return Object.freeze({
    status: hasEntries ? 'key_present' : 'clean',
    problem: hasEntries ? 'opencode_auth_key_present' : null,
    path: OPENCODE_AUTH_DISPLAY_PATH,
  })
}

function sha256IfFile(filePath) {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return null
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

function readPluginJsonVersion(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Inspect bundled plugin metadata and local host caches (`~/.claude`, `~/.codex`,
 * `~/.zcode`, `~/.gemini`) strictly read-only.
 */
export function inspectPluginVersions({ pluginRoot = PLUGIN_ROOT, env = process.env } = {}) {
  const home = env?.HOME || env?.USERPROFILE || homedir()
  const bundledVersion = readPluginJsonVersion(pluginRoot)
  const expectedHashes = Object.fromEntries(
    KEY_CACHE_PROBE_FILES.map((rel) => [rel, sha256IfFile(join(pluginRoot, rel))]),
  )
  const cacheTargets = [
    { name: 'claude', dir: join(home, '.claude', 'plugins', 'cache', 'tmux-teams', 'tmux-teams') },
    { name: 'codex', dir: join(home, '.codex', 'plugins', 'cache', 'tmux-teams', 'tmux-teams') },
    { name: 'zcode', dir: join(home, '.zcode', 'cli', 'plugins', 'cache', 'tmux-teams', 'tmux-teams') },
  ]
  const caches = cacheTargets.map(({ name, dir }) => {
    if (!existsSync(dir)) {
      return Object.freeze({ target: name, status: 'absent', versions: Object.freeze([]), stale: false, drifted: false })
    }
    let versionDirs = []
    try {
      versionDirs = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    } catch {
      versionDirs = []
    }
    if (versionDirs.length === 0) {
      return Object.freeze({ target: name, status: 'absent', versions: Object.freeze([]), stale: false, drifted: false })
    }
    const latestDirName = versionDirs[versionDirs.length - 1]
    const latestDir = join(dir, latestDirName)
    const manifestVersion = readPluginJsonVersion(latestDir) ?? latestDirName
    const stale = Boolean(bundledVersion && manifestVersion !== bundledVersion)
    const missingOrDiffering = KEY_CACHE_PROBE_FILES.filter((rel) => {
      const actual = sha256IfFile(join(latestDir, rel))
      return expectedHashes[rel] && actual !== expectedHashes[rel]
    })
    const drifted = missingOrDiffering.length > 0
    const status = stale ? 'stale' : drifted ? 'drifted' : 'current'
    return Object.freeze({
      target: name,
      status,
      versions: Object.freeze(versionDirs),
      manifestVersion,
      stale,
      drifted,
    })
  })

  const agyLink = join(home, '.gemini', 'config', 'plugins', 'tmux-teams')
  let antigravityStatus = 'absent'
  try {
    if (existsSync(agyLink) || lstatSync(agyLink).isSymbolicLink()) {
      const linkVersion = readPluginJsonVersion(agyLink)
      antigravityStatus = bundledVersion && linkVersion === bundledVersion ? 'linked_current' : 'linked_other'
    }
  } catch {
    antigravityStatus = 'absent'
  }

  return Object.freeze({
    bundledVersion,
    caches: Object.freeze(caches),
    antigravity: antigravityStatus,
    needsUpdate: caches.some((c) => c.stale || c.drifted),
  })
}

export function checkBmadState({ projectRoot = process.cwd(), env = process.env } = {}) {
  const home = env?.HOME || env?.USERPROFILE || homedir()
  const hasProjectBmad = existsSync(join(projectRoot, '_bmad'))
  const globalPartyDir = join(home, '.claude', 'skills', 'bmad-party-mode')
  const hasGlobalParty = existsSync(join(globalPartyDir, 'scripts', 'resolve_party.py'))
  const projectPartyCandidates = [
    join(projectRoot, '.claude', 'skills', 'bmad-party-mode'),
    join(projectRoot, '.agents', 'skills', 'bmad-party-mode'),
  ]
  const detectedProjectPartyDir = projectPartyCandidates.find((dir) => existsSync(join(dir, 'scripts', 'resolve_party.py'))) ?? null
  return Object.freeze({
    hasProjectBmad,
    globalPartyDir,
    hasGlobalParty,
    hasProjectParty: Boolean(detectedProjectPartyDir),
    projectPartyDir: detectedProjectPartyDir,
    ready: hasProjectBmad || hasGlobalParty || Boolean(detectedProjectPartyDir),
  })
}

function checkPythonRuntime({ env = process.env, run = spawnSync } = {}) {
  const safeEnv = buildSafePythonEnv(env)
  let uvAvailable = false
  try {
    const uvRes = run('uv', ['--version'], { env: safeEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
    uvAvailable = Boolean(uvRes && !uvRes.error && uvRes.status === 0)
  } catch {
    uvAvailable = false
  }
  let pythonVersion = null
  let pythonEligible = false
  try {
    const pyRes = run('python3', ['--version'], { env: safeEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
    if (pyRes && !pyRes.error && pyRes.status === 0) {
      const parsed = parsePythonVersion(`${pyRes.stdout ?? ''}\n${pyRes.stderr ?? ''}`)
      if (parsed) {
        pythonVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`
        pythonEligible = parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 11)
      }
    }
  } catch {
    pythonVersion = null
  }
  return Object.freeze({
    uvAvailable,
    pythonVersion,
    pythonEligible,
    ready: uvAvailable || pythonEligible,
    mode: uvAvailable ? 'uv' : pythonEligible ? 'python3-fallback' : 'missing',
  })
}

function gateEnvForSetup(env = process.env) {
  try {
    return { ...buildProfileEnv('opencode', env) }
  } catch {
    const base = cleanGateNpmEnv(env)
    const gatePath = executablePath(env)
    return gatePath ? { ...base, PATH: gatePath } : base
  }
}

function verifyAuthenticNpmNpx(resolvedNpx) {
  try {
    if (process.platform !== 'win32') accessSync(resolvedNpx, fsConstants.X_OK)
    const realNpx = realpathSync(resolvedNpx)
    if (!statSync(realNpx).isFile()) return null
    if (process.platform !== 'win32') accessSync(realNpx, fsConstants.X_OK)
    const isRelativeSubpath = (rel) =>
      typeof rel === 'string' &&
      rel.length > 0 &&
      !rel.startsWith('/') &&
      !rel.startsWith('\\') &&
      !rel.split(/[\\/]/).includes('..')
    let dir = dirname(realNpx)
    for (let depth = 0; depth < 4; depth += 1) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkgStat = lstatSync(pkgPath)
        if (!pkgStat.isFile() || pkgStat.isSymbolicLink()) return null
        const pkgRoot = realpathSync(dir)
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg?.name !== 'npm' || !pkg.bin || typeof pkg.bin !== 'object' || Array.isArray(pkg.bin)) {
          return null
        }
        const npxRel = pkg.bin.npx
        const npmRel = pkg.bin.npm
        if (!isRelativeSubpath(npxRel) || !isRelativeSubpath(npmRel)) return null
        const expectedNpx = realpathSync(resolve(pkgRoot, npxRel))
        const expectedNpm = realpathSync(resolve(pkgRoot, npmRel))
        if (!expectedNpx.startsWith(pkgRoot + sep) || !expectedNpm.startsWith(pkgRoot + sep)) return null
        if (expectedNpx !== realNpx) return null
        if (!statSync(expectedNpm).isFile()) return null
        if (process.platform !== 'win32') accessSync(expectedNpm, fsConstants.X_OK)
        const siblingNpm = join(dirname(resolvedNpx), process.platform === 'win32' ? 'npm.cmd' : 'npm')
        let npmCommand = expectedNpm
        if (existsSync(siblingNpm)) {
          try {
            if (statSync(siblingNpm).isFile()) {
              if (process.platform !== 'win32') accessSync(siblingNpm, fsConstants.X_OK)
              if (realpathSync(siblingNpm) === expectedNpm) npmCommand = siblingNpm
            }
          } catch {}
        }
        return Object.freeze({ npmCommand, npmPackageRoot: pkgRoot, realNpx, realNpm: expectedNpm })
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  } catch {
    return null
  }
}

function inspectGateLauncher(env = process.env, { projectRoot } = {}) {
  let gateEnv
  try {
    gateEnv = { ...buildProfileEnv('opencode', env) }
  } catch {
    return Object.freeze({ kind: 'untrusted', gatePath: executablePath(env), resolvedCommand: null, npmCommand: null })
  }
  const gatePath = gateEnv.PATH ?? ''
  const canonicalTarget = typeof projectRoot === 'string' && projectRoot.trim()
    ? canonicalForContainment(projectRoot)
    : undefined
  let resolvedNpx
  try {
    resolvedNpx = resolveExecutableSync('npx', gateEnv, {
      profileId: 'opencode',
      targetRepository: canonicalTarget,
    })
  } catch {
    return Object.freeze({ kind: 'untrusted', gatePath, resolvedCommand: null, npmCommand: null })
  }
  if (!resolvedNpx) {
    return Object.freeze({ kind: 'missing', gatePath, resolvedCommand: null, npmCommand: null })
  }
  if (process.platform !== 'win32') {
    try {
      accessSync(resolvedNpx, fsConstants.X_OK)
    } catch {
      return Object.freeze({ kind: 'untrusted', gatePath, resolvedCommand: null, npmCommand: null })
    }
  }
  const npmInfo = verifyAuthenticNpmNpx(resolvedNpx)
  if (npmInfo) {
    return Object.freeze({
      kind: 'npm_npx',
      gatePath,
      resolvedCommand: resolvedNpx,
      npmCommand: npmInfo.npmCommand,
    })
  }
  return Object.freeze({
    kind: 'custom_shim',
    gatePath,
    resolvedCommand: resolvedNpx,
    npmCommand: null,
  })
}

function launcherFailureCode(kind) {
  return kind === 'custom_shim'
    ? 'opencode_custom_npx_shim'
    : kind === 'untrusted'
      ? 'opencode_launcher_untrusted'
      : 'npx_missing'
}

function cacheFailureCode(code) {
  return code === 'unverified'
    ? 'opencode_prefix_unverified'
    : code === 'drifted'
      ? 'opencode_version_drift'
      : 'opencode_missing'
}

/**
 * Evaluate full environment readiness for tmux-teams (Node, git, npx,
 * optional bunx/tmux, BMAD, global bmad-party-mode, uv/python3>=3.11,
 * @opencode/cli@2.3.2 cache + binary, auth.json safety, and plugin caches).
 */
export function checkSetup({
  projectRoot = process.cwd(),
  env = process.env,
  run = spawnSync,
  pluginRoot = PLUGIN_ROOT,
  inspectCache = inspectOpencodeCache,
  nodeVersion = process.versions.node,
  allowProjectParty = false,
  verifyBinary = false,
} = {}) {
  const problems = []
  const warnings = []
  const unsafeRoot = isUnsafeProjectRoot(projectRoot, { env, pluginRoot })
  if (unsafeRoot) problems.push('unsafe_project_root')

  const binaries = pluginReadiness(env)
  for (const m of binaries.missing) {
    if (m.missing === 'node') problems.push('node_missing')
    else if (m.missing === 'git') problems.push('git_missing')
    else if (m.missing === 'npx') problems.push('npx_missing')
  }
  const nodeMajor = Number.parseInt(String(nodeVersion ?? '').split('.')[0], 10)
  const nodeVersionOk = Number.isInteger(nodeMajor) && nodeMajor >= 20
  if (!binaries.missing.some((m) => m.missing === 'node') && !nodeVersionOk) {
    problems.push('node_too_old')
  }

  const gateEnv = gateEnvForSetup(env)
  const launcher = inspectGateLauncher(env, { projectRoot })
  const hasVerifiedNpmLauncher = launcher.kind === 'npm_npx' && Boolean(launcher.npmCommand)
  const minimalProbeEnv = {
    ...(gateEnv.PATH ? { PATH: gateEnv.PATH } : {}),
    ...(gateEnv.HOME ? { HOME: gateEnv.HOME } : {}),
  }
  const cacheResult = hasVerifiedNpmLauncher
    ? inspectCache({
        env: gateEnv,
        verifyBinary,
        run,
        includePlantFallback: false,
        exactSlotOnly: true,
        ignoreAmbientNpmCache: true,
        includeGlobalPrefix: true,
        npmCommand: launcher.npmCommand,
      })
    : Object.freeze({ ok: false, code: 'skipped', rootsChecked: Object.freeze([]) })
  let pathVersion = ''
  if (verifyBinary && hasVerifiedNpmLauncher) {
    try {
      const binProbe = run('opencode', ['--version'], { env: minimalProbeEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
      if (binProbe && !binProbe.error && binProbe.status === 0) {
        pathVersion = parseOpencodeVersion(`${binProbe.stdout ?? ''}\n${binProbe.stderr ?? ''}`)
      }
    } catch {
      pathVersion = ''
    }
  }
  const binaryVersionMatches = pathVersion === OPENCODE_VERSION
  // Review/advisor lanes invoke pinned `npx -y @opencode/cli@2.3.2 acp` on executablePath(env) via resolveExecutable.
  if (!hasVerifiedNpmLauncher) {
    problems.push(launcherFailureCode(launcher.kind))
  }
  const opencodeReady = hasVerifiedNpmLauncher && cacheResult.ok
  if (hasVerifiedNpmLauncher) {
    if (!cacheResult.ok) {
      if (cacheResult.code === 'missing' && pathVersion && !binaryVersionMatches) {
        problems.push('opencode_version_drift')
      } else {
        problems.push(cacheFailureCode(cacheResult.code))
      }
    } else if (pathVersion && !binaryVersionMatches) {
      warnings.push('opencode_version_drift')
    }
  }

  const bmad = checkBmadState({ projectRoot, env })
  const bmadReady = bmad.hasProjectBmad || bmad.hasGlobalParty || (allowProjectParty && bmad.hasProjectParty)
  if (!bmadReady) problems.push('bmad_missing')
  if (!bmad.hasGlobalParty) warnings.push('bmad_party_missing')

  const python = checkPythonRuntime({ env, run })
  if (!python.uvAvailable) {
    if (python.pythonEligible) warnings.push('uv_missing')
    else problems.push('python_runtime_missing')
  }

  const auth = inspectOpencodeAuth(env)
  if (auth.problem) warnings.push(auth.problem)

  const pluginStatus = inspectPluginVersions({ pluginRoot, env })
  if (pluginStatus.caches.some((c) => c.stale)) warnings.push('plugin_cache_stale')
  else if (pluginStatus.caches.some((c) => c.drifted)) warnings.push('plugin_cache_drifted')

  const blockingForFree = new Set([
    'unsafe_project_root',
    'node_missing',
    'node_too_old',
    'git_missing',
    'npx_missing',
    'opencode_launcher_untrusted',
    'opencode_prefix_unverified',
    'opencode_missing',
    'opencode_version_drift',
    'opencode_custom_npx_shim',
    'bmad_missing',
  ])
  const readyForOpencodeFree = !problems.some((code) => blockingForFree.has(code))
  const partyUsable = bmad.hasGlobalParty || (allowProjectParty && bmad.hasProjectParty)
  const readyForBmadParty = !unsafeRoot && partyUsable && python.ready

  return Object.freeze({
    ok: readyForOpencodeFree && readyForBmadParty,
    readyForOpencodeFree,
    readyForBmadParty,
    projectRoot: resolve(projectRoot),
    unsafeRoot,
    problems: Object.freeze([...new Set(problems)]),
    warnings: Object.freeze([...new Set(warnings)]),
    binaries,
    bmad: Object.freeze({
      hasProjectBmad: bmad.hasProjectBmad,
      hasGlobalParty: bmad.hasGlobalParty,
      hasProjectParty: bmad.hasProjectParty,
      ready: bmadReady,
      globalPartyDisplayPath: '~/.claude/skills/bmad-party-mode',
    }),
    python,
    opencode: Object.freeze({
      packageSpec: OPENCODE_SPEC,
      expectedVersion: OPENCODE_VERSION,
      cacheOk: cacheResult.ok,
      cacheCode: cacheResult.code,
      installSource: cacheResult.installSource ?? null,
      launcherKind: launcher.kind,
      pathVersion: pathVersion || null,
      verifiedBy: verifyBinary ? 'binary' : 'metadata',
      ready: opencodeReady,
    }),
    auth,
    pluginStatus,
  })
}

/** Build a deterministic, inspectable installation plan from a readiness report. */
export function planInstall(report, {
  projectRoot = report?.projectRoot ?? process.cwd(),
  env = process.env,
  withProfile = false,
  profileOut,
  allowProjectParty = false,
  pluginRoot = PLUGIN_ROOT,
} = {}) {
  if (isUnsafeProjectRoot(projectRoot, { env, pluginRoot })) {
    return Object.freeze({
      ok: false,
      code: 'unsafe_project_root',
      message: SETUP_PROBLEMS.unsafe_project_root,
      steps: Object.freeze([]),
    })
  }
  const absProject = resolve(projectRoot)
  const steps = []
  const notes = []
  const willInstallBmad = !report?.bmad?.hasProjectBmad
  if (willInstallBmad) {
    steps.push(Object.freeze({
      id: 'install-bmad',
      kind: 'exec',
      command: 'npx',
      args: Object.freeze(['-y', BMAD_METHOD_SPEC, 'install', '--directory', absProject, '--modules', 'bmm', '--tools', 'claude-code,codex,opencode', '--yes']),
      description: `Install ${BMAD_METHOD_SPEC} (bmm module) into ${absProject}`,
    }))
  }
  if (!report?.bmad?.hasGlobalParty) {
    if (willInstallBmad || allowProjectParty) {
      steps.push(Object.freeze({
        id: 'copy-global-bmad-party',
        kind: 'copy_dir',
        projectRoot: absProject,
        srcRelative: join('.claude', 'skills', 'bmad-party-mode'),
        destDisplayPath: '~/.claude/skills/bmad-party-mode',
        allowProjectParty: Boolean(allowProjectParty),
        requireFreshInstall: willInstallBmad && !allowProjectParty,
        onlyIfAbsent: true,
        description: willInstallBmad
          ? 'Copy freshly installed bmad-party-mode to global ~/.claude/skills/bmad-party-mode when absent'
          : 'Copy opted-in project bmad-party-mode to global ~/.claude/skills/bmad-party-mode when absent',
      }))
    } else {
      notes.push('Note: ~/.claude/skills/bmad-party-mode is absent and _bmad already exists; existing project scripts are not auto-promoted without --allow-project-party.')
    }
  }
  if (!report?.opencode?.cacheOk) {
    steps.push(Object.freeze({
      id: 'warm-opencode-cache',
      kind: 'exec',
      command: 'npx',
      args: Object.freeze(['-y', OPENCODE_SPEC, '--version']),
      description: `Warm pinned ${OPENCODE_SPEC} in npm _npx cache`,
    }))
  }
  if (withProfile) {
    const outPath = profileOut ? resolve(profileOut) : join(absProject, '.tmux-teams', 'opencode-execution-profile.json')
    const outDir = dirname(outPath)
    if (isUnsafeProjectRoot(outDir, { env, pluginRoot })) {
      return Object.freeze({
        ok: false,
        code: 'unsafe_project_root',
        message: SETUP_PROBLEMS.unsafe_project_root,
        steps: Object.freeze([]),
      })
    }
    if (!profileOut && !canonicalForContainment(outPath).startsWith(canonicalForContainment(absProject) + sep)) {
      return Object.freeze({
        ok: false,
        code: 'unsafe_project_root',
        message: SETUP_PROBLEMS.unsafe_project_root,
        steps: Object.freeze([]),
      })
    }
    steps.push(Object.freeze({
      id: 'write-opencode-profile',
      kind: 'profile',
      outputPath: outPath,
      customOut: Boolean(profileOut),
      description: `Write closed OpenCode ACP execution profile to ${outPath}`,
    }))
  }
  if (report?.pluginStatus?.needsUpdate) {
    steps.push(Object.freeze({
      id: 'plugin-update-hint',
      kind: 'manual',
      command: Object.freeze(['claude', 'plugin', 'update', 'tmux-teams']),
      description: 'Update local Claude/Codex/ZCode plugin caches manually (never passes --yes)',
    }))
  }
  if (report?.auth?.status === 'key_present') {
    notes.push(`Manual auth note: ${SETUP_PROBLEMS.opencode_auth_key_present}`)
  }
  if (report?.python?.mode === 'python3-fallback') {
    notes.push('Note: uv is missing; advisor-party.mjs uses python3 >= 3.11 fallback. Install uv manually if you prefer isolated Python environments.')
  }
  return Object.freeze({
    ok: true,
    code: 'ok',
    projectRoot: absProject,
    allowProjectParty: Boolean(allowProjectParty),
    steps: Object.freeze(steps),
    notes: Object.freeze(notes),
  })
}

function findInstalledProjectPartyDir(projectRoot) {
  for (const rel of ['.claude', '.agents']) {
    const candidate = join(projectRoot, rel, 'skills', 'bmad-party-mode')
    if (existsSync(join(candidate, 'scripts', 'resolve_party.py'))) return candidate
  }
  return null
}

/**
 * Execute a setup install plan. `--dryRun` ALWAYS wins over `yes`, child
 * environments scrub API/token secrets, and manual steps are never auto-run.
 */
export function runInstall(plan, {
  dryRun = false,
  yes = false,
  env = process.env,
  run = spawnSync,
  copyDir = cpSync,
  inspectCache = inspectOpencodeCache,
  buildProfile = buildOpencodeProfile,
  pluginRoot = PLUGIN_ROOT,
} = {}) {
  if (!plan?.ok) {
    return Object.freeze({
      ok: false,
      code: plan?.code ?? 'unsafe_project_root',
      message: plan?.message ?? SETUP_PROBLEMS.unsafe_project_root,
      dryRun: true,
      applied: Object.freeze([]),
      skipped: Object.freeze([]),
    })
  }
  if (dryRun || !yes) {
    return Object.freeze({
      ok: true,
      code: 'dry_run',
      dryRun: true,
      applied: Object.freeze([]),
      skipped: plan.steps,
      notes: plan.notes,
    })
  }

  const gateNpmEnv = gateEnvForSetup(env)
  const launcher = inspectGateLauncher(env, { projectRoot: plan.projectRoot })
  const hasVerifiedNpmLauncher = launcher.kind === 'npm_npx' && Boolean(launcher.npmCommand)
  const hasPathOrSymlink = (p) => existsSync(p) || isSymlinkPath(p)
  const hadProjectPartyBeforeInstall =
    hasPathOrSymlink(join(plan.projectRoot, '.claude', 'skills', 'bmad-party-mode')) ||
    hasPathOrSymlink(join(plan.projectRoot, '.agents', 'skills', 'bmad-party-mode'))
  const applied = []
  for (const step of plan.steps) {
    if (step.kind === 'manual') continue
    if (step.kind === 'exec') {
      if (step.id === 'warm-opencode-cache' && !hasVerifiedNpmLauncher) {
        return Object.freeze({
          ok: false,
          code: launcherFailureCode(launcher.kind),
          failedStep: step.id,
          dryRun: false,
          applied: Object.freeze(applied),
        })
      }
      if (step.id === 'install-bmad') {
        if (!launcher.resolvedCommand) {
          return Object.freeze({
            ok: false,
            code: launcherFailureCode(launcher.kind),
            failedStep: step.id,
            dryRun: false,
            applied: Object.freeze(applied),
          })
        }
        try {
          for (const target of [
            join(plan.projectRoot, '_bmad'),
            join(plan.projectRoot, '_bmad-output'),
            join(plan.projectRoot, '.claude', 'skills', 'bmad-party-mode'),
            join(plan.projectRoot, '.agents', 'skills', 'bmad-party-mode'),
            join(plan.projectRoot, '.opencode', 'commands'),
          ]) {
            assertSafePathChain(target, { projectRoot: plan.projectRoot, enforceProjectContainment: true, env, pluginRoot })
          }
          for (const dir of [
            join(plan.projectRoot, '_bmad'),
            join(plan.projectRoot, '.claude', 'skills'),
            join(plan.projectRoot, '.agents', 'skills'),
            join(plan.projectRoot, '.opencode', 'commands'),
          ]) {
            if (existsSync(dir) && treeHasSymlink(dir)) {
              return Object.freeze({
                ok: false,
                code: 'install_failed',
                failedStep: step.id,
                dryRun: false,
                applied: Object.freeze(applied),
              })
            }
          }
        } catch {
          return Object.freeze({
            ok: false,
            code: 'install_failed',
            failedStep: step.id,
            dryRun: false,
            applied: Object.freeze(applied),
          })
        }
      }
      const execCwd = mkdtempSync(join(tmpdir(), 'tmux-teams-setup-exec-'))
      let res
      try {
        res = run(launcher.resolvedCommand ?? step.command, [...step.args], {
          env: gateNpmEnv,
          cwd: execCwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } finally {
        try { rmSync(execCwd, { recursive: true, force: true }) } catch {}
      }
      if (!res || res.error || res.status !== 0) {
        return Object.freeze({
          ok: false,
          code: 'install_failed',
          failedStep: step.id,
          dryRun: false,
          applied: Object.freeze(applied),
        })
      }
      if (step.id === 'warm-opencode-cache') {
        const warmed = inspectCache({
          env: gateNpmEnv,
          verifyBinary: false,
          run,
          includePlantFallback: false,
          exactSlotOnly: true,
          ignoreAmbientNpmCache: true,
          includeGlobalPrefix: true,
          npmCommand: launcher.npmCommand,
        })
        if (!warmed.ok) {
          return Object.freeze({
            ok: false,
            code: cacheFailureCode(warmed.code),
            failedStep: step.id,
            dryRun: false,
            applied: Object.freeze(applied),
          })
        }
      }
      applied.push(step.id)
      continue
    }
    if (step.kind === 'copy_dir') {
      const dest = step.dest ?? join(env?.HOME || env?.USERPROFILE || homedir(), '.claude', 'skills', 'bmad-party-mode')
      if (isSymlinkPath(dest)) {
        return Object.freeze({ ok: false, code: 'install_failed', failedStep: step.id, dryRun: false, applied: Object.freeze(applied) })
      }
      if (existsSync(dest)) {
        continue
      }
      if (step.requireFreshInstall && (hadProjectPartyBeforeInstall || !applied.includes('install-bmad'))) {
        continue
      }
      const rootForStep = step.projectRoot ?? plan.projectRoot
      const candidateSrc = step.src && existsSync(join(step.src, 'scripts', 'resolve_party.py'))
        ? step.src
        : step.srcRelative && existsSync(join(rootForStep, step.srcRelative, 'scripts', 'resolve_party.py'))
          ? join(rootForStep, step.srcRelative)
          : findInstalledProjectPartyDir(rootForStep)
      if (!candidateSrc) continue
      try {
        assertSafePathChain(dest, { projectRoot: rootForStep, enforceProjectContainment: false, env, pluginRoot })
        assertSafePathChain(candidateSrc, { projectRoot: rootForStep, enforceProjectContainment: true, env, pluginRoot })
        if (isSymlinkPath(candidateSrc) || treeHasSymlink(candidateSrc)) {
          return Object.freeze({ ok: false, code: 'install_failed', failedStep: step.id, dryRun: false, applied: Object.freeze(applied) })
        }
        mkdirSync(dirname(dest), { recursive: true })
        copyDir(candidateSrc, dest, { recursive: true, force: false, errorOnExist: true, dereference: false })
      } catch {
        return Object.freeze({ ok: false, code: 'install_failed', failedStep: step.id, dryRun: false, applied: Object.freeze(applied) })
      }
      applied.push(step.id)
      continue
    }
    if (step.kind === 'profile') {
      if (/\s/.test(step.outputPath)) {
        return Object.freeze({ ok: false, code: 'profile_write_failed', failedStep: step.id, dryRun: false, applied: Object.freeze(applied) })
      }
      if (!hasVerifiedNpmLauncher) {
        return Object.freeze({
          ok: false,
          code: launcherFailureCode(launcher.kind),
          failedStep: step.id,
          dryRun: false,
          applied: Object.freeze(applied),
        })
      }
      const cacheRes = inspectCache({
        env: gateNpmEnv,
        verifyBinary: true,
        run,
        includePlantFallback: false,
        exactSlotOnly: true,
        ignoreAmbientNpmCache: true,
        includeGlobalPrefix: true,
        npmCommand: launcher.npmCommand,
      })
      if (!cacheRes.ok) {
        return Object.freeze({
          ok: false,
          code: cacheFailureCode(cacheRes.code),
          failedStep: step.id,
          dryRun: false,
          applied: Object.freeze(applied),
        })
      }
      try {
        const profile = buildProfile({
          metadataPath: cacheRes.install.metadata_path,
          entryPath: cacheRes.install.entry_path,
          reportedVersionLine: cacheRes.install.reported_version_line,
        })
        writeProfileSafely(step.outputPath, profile, {
          projectRoot: plan.projectRoot,
          enforceProjectContainment: !step.customOut,
          env,
          pluginRoot,
        })
      } catch {
        return Object.freeze({ ok: false, code: 'profile_write_failed', failedStep: step.id, dryRun: false, applied: Object.freeze(applied) })
      }
      applied.push(step.id)
    }
  }

  const after = checkSetup({
    projectRoot: plan.projectRoot,
    env,
    run,
    pluginRoot,
    inspectCache,
    allowProjectParty: Boolean(plan.allowProjectParty),
  })
  return Object.freeze({
    ok: after.ok,
    code: after.ok ? 'ok' : (after.problems[0] ?? 'install_failed'),
    dryRun: false,
    applied: Object.freeze(applied),
    report: after,
    notes: plan.notes,
  })
}

function isSymlinkPath(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function treeHasSymlink(rootDir) {
  if (isSymlinkPath(rootDir)) return true
  const entries = readdirSync(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(rootDir, entry.name)
    if (entry.isSymbolicLink() || isSymlinkPath(full)) return true
    if (entry.isDirectory() && treeHasSymlink(full)) return true
  }
  return false
}

const ALLOWED_OS_ROOT_SYMLINKS = process.platform === 'darwin'
  ? new Set(['/tmp', '/var'])
  : new Set()

function assertSafePathChain(targetPath, { projectRoot, enforceProjectContainment = true, env, pluginRoot } = {}) {
  const absTarget = resolve(targetPath)
  const root = parse(absTarget).root
  const segments = absTarget.slice(root.length).split(sep).filter(Boolean)
  let current = root
  let lastExistingAncestor = existsSync(root) ? root : null
  for (let i = 0; i < segments.length; i += 1) {
    current = current === root ? `${root}${segments[i]}` : join(current, segments[i])
    const isLeaf = i === segments.length - 1
    if (isSymlinkPath(current)) {
      const allowOsAlias = !isLeaf && ALLOWED_OS_ROOT_SYMLINKS.has(current)
      if (!allowOsAlias) {
        throw new Error(`refusing symlink path component: ${current}`)
      }
    }
    if (existsSync(current) && !isLeaf) {
      lastExistingAncestor = current
    }
  }
  if (!lastExistingAncestor) {
    throw new Error('profile ancestor does not exist')
  }
  const canonicalAncestor = realpathSync(lastExistingAncestor)
  if (!lstatSync(canonicalAncestor).isDirectory()) {
    throw new Error('profile ancestor is not an existing directory')
  }
  const resolvedPlugin = canonicalForContainment(pluginRoot)
  if (canonicalAncestor === resolvedPlugin || canonicalAncestor.startsWith(resolvedPlugin + sep)) {
    throw new Error('unsafe profile ancestor')
  }
  if (enforceProjectContainment) {
    const canonicalProject = realpathSync(projectRoot)
    if (canonicalAncestor !== canonicalProject && !canonicalAncestor.startsWith(canonicalProject + sep)) {
      throw new Error('profile ancestor escaped project root')
    }
  }
  return canonicalAncestor
}

function writeProfileSafely(targetPath, profile, { projectRoot, enforceProjectContainment = true, env, pluginRoot } = {}) {
  const dir = dirname(targetPath)
  if (isUnsafeProjectRoot(dir, { env, pluginRoot })) throw new Error('unsafe profile dir')
  if (isSymlinkPath(targetPath)) throw new Error('refusing symlink profile target')
  assertSafePathChain(targetPath, { projectRoot, enforceProjectContainment, env, pluginRoot })
  mkdirSync(dir, { recursive: true })
  const canonicalDir = realpathSync(dir)
  if (isUnsafeProjectRoot(canonicalDir, { env, pluginRoot })) throw new Error('unsafe profile dir')
  if (enforceProjectContainment) {
    const canonicalProject = realpathSync(projectRoot)
    if (canonicalDir !== canonicalProject && !canonicalDir.startsWith(canonicalProject + sep)) {
      throw new Error('profile dir escaped project root')
    }
  }
  const dest = join(canonicalDir, basename(targetPath))
  if (isSymlinkPath(dest)) throw new Error('refusing symlink profile target')
  if (existsSync(dest) && lstatSync(dest).isDirectory()) throw new Error('profile target is a directory')
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  const temporary = join(canonicalDir, `.${basename(targetPath)}.${nonce}.tmp`)
  const bytes = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
  } catch (err) {
    try { closeSync(fd) } catch {}
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
    throw err
  }
  closeSync(fd)
  renameSync(temporary, dest)
}

function parseCliArgs(argv) {
  const args = [...argv]
  const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'check'
  const opts = {
    cmd,
    json: false,
    dryRun: false,
    yes: false,
    withProfile: false,
    allowProjectParty: false,
    projectRoot: process.cwd(),
    profileOut: null,
    help: false,
  }
  while (args.length > 0) {
    const token = args.shift()
    if (token === '--help' || token === '-h') opts.help = true
    else if (token === '--json') opts.json = true
    else if (token === '--dry-run') opts.dryRun = true
    else if (token === '--yes' || token === '-y') opts.yes = true
    else if (token === '--with-profile') opts.withProfile = true
    else if (token === '--allow-project-party') opts.allowProjectParty = true
    else if (token === '--project-root' || token === '--profile-out') {
      const value = args.shift()
      if (typeof value !== 'string' || !value || value.startsWith('-')) return { error: `missing value for ${token}` }
      if (token === '--project-root') opts.projectRoot = value
      else opts.profileOut = value
    } else {
      return { error: `unknown option: ${token}` }
    }
  }
  return opts
}

function formatCheckText(report) {
  const opencodeDetail = report.opencode.ready && report.opencode.verifiedBy === 'metadata'
    ? (report.opencode.installSource === 'npm_global'
        ? 'metadata verified (global npm bin; live launch/catalog not probed)'
        : 'metadata verified (exact _npx slot; live launch/catalog not probed)')
    : (report.opencode.cacheOk ? 'ok' : report.opencode.cacheCode)
  const lines = [
    `tmux-teams-setup check (${report.projectRoot})`,
    `  prerequisite metadata for opencode-free : ${report.readyForOpencodeFree ? 'READY (metadata only; live launch/catalog not probed)' : 'NOT READY'}`,
    `  prerequisite metadata for bmad-party    : ${report.readyForBmadParty ? 'READY' : 'NOT READY'}`,
    `  opencode (${report.opencode.packageSpec}) : ${opencodeDetail}, launcher=${report.opencode.launcherKind}${report.opencode.installSource ? ` (${report.opencode.installSource})` : ''}${report.opencode.pathVersion ? `, path=${report.opencode.pathVersion}` : ''}`,
    `  bmad (_bmad / party)                    : project=${report.bmad.hasProjectBmad}, globalParty=${report.bmad.hasGlobalParty}, projectParty=${report.bmad.hasProjectParty}`,
    `  python runtime                          : ${report.python.mode}${report.python.pythonVersion ? ` (python ${report.python.pythonVersion})` : ''}`,
    `  opencode auth (${report.auth.path})     : ${report.auth.status}`,
    `  bundled plugin version                  : ${report.pluginStatus.bundledVersion ?? 'unknown'}`,
  ]
  for (const cache of report.pluginStatus.caches) {
    lines.push(`    cache[${cache.target}] : ${cache.status} (${cache.versions.join(', ') || 'none'})`)
  }
  for (const code of report.problems) lines.push(`  BLOCKING: ${code} — ${SETUP_PROBLEMS[code] ?? code}`)
  for (const code of report.warnings) lines.push(`  WARNING : ${code} — ${SETUP_PROBLEMS[code] ?? code}`)
  return lines.join('\n')
}

export function main(argv, {
  env = process.env,
  out = console.log,
  err = console.error,
  run = spawnSync,
  copyDir = cpSync,
  inspectCache = inspectOpencodeCache,
  pluginRoot = PLUGIN_ROOT,
} = {}) {
  const parsed = parseCliArgs(argv)
  const usage = 'usage: node tmux-teams-setup.mjs [check|install|plugin-status] [--json] [--dry-run] [--yes] [--with-profile] [--project-root <dir>]'
  if (parsed.error) {
    err(parsed.error)
    err(usage)
    return 1
  }
  if (parsed.help) {
    out(usage)
    return 0
  }
  if (parsed.cmd === 'plugin-status') {
    const status = inspectPluginVersions({ pluginRoot, env })
    out(parsed.json ? JSON.stringify(status, null, 2) : [
      `bundled: ${status.bundledVersion ?? 'unknown'}`,
      `antigravity: ${status.antigravity}`,
      ...status.caches.map((c) => `cache[${c.target}]: ${c.status} (${c.versions.join(', ') || 'none'})`),
    ].join('\n'))
    return 0
  }
  if (parsed.cmd === 'check') {
    const report = checkSetup({
      projectRoot: parsed.projectRoot,
      env,
      run,
      pluginRoot,
      inspectCache,
      allowProjectParty: parsed.allowProjectParty,
    })
    out(parsed.json ? JSON.stringify(report, null, 2) : formatCheckText(report))
    return report.readyForOpencodeFree && report.readyForBmadParty ? 0 : 2
  }
  if (parsed.cmd === 'install') {
    const report = checkSetup({
      projectRoot: parsed.projectRoot,
      env,
      run,
      pluginRoot,
      inspectCache,
      allowProjectParty: parsed.allowProjectParty,
      verifyBinary: false,
    })
    const plan = planInstall(report, {
      projectRoot: parsed.projectRoot,
      env,
      withProfile: parsed.withProfile,
      profileOut: parsed.profileOut,
      allowProjectParty: parsed.allowProjectParty,
      pluginRoot,
    })
    if (!plan.ok) {
      out(parsed.json ? JSON.stringify(plan, null, 2) : `${plan.code}: ${plan.message}`)
      return 2
    }
    const result = runInstall(plan, {
      dryRun: parsed.dryRun,
      yes: parsed.yes,
      env,
      run,
      copyDir,
      inspectCache,
      pluginRoot,
    })
    if (parsed.json) out(JSON.stringify({ plan, result }, null, 2))
    else if (result.dryRun) {
      out('tmux-teams-setup install plan (dry-run; pass --yes without --dry-run to execute):')
      for (const s of plan.steps) out(`  - [${s.kind}] ${s.id}: ${s.description}`)
      for (const note of plan.notes) out(`  ${note}`)
    } else if (result.ok) {
      out(`tmux-teams-setup install complete (applied: ${result.applied.join(', ') || 'none'})`)
    } else {
      out(`tmux-teams-setup install FAILED (code: ${result.code}${result.failedStep ? `, step: ${result.failedStep}` : ''}; applied: ${result.applied.join(', ') || 'none'})`)
    }
    return result.ok ? 0 : 2
  }
  err(`unknown command: ${parsed.cmd}`)
  err(usage)
  return 1
}

function invokedDirectly() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
  } catch {
    return false
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2))
