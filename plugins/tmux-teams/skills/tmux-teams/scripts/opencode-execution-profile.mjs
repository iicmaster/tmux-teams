#!/usr/bin/env node
// opencode-execution-profile.mjs — produce the closed ACP execution profile a
// receipt-required custom-worker dispatch needs (`ACP_EXECUTION_PROFILE`).
//
// `acp-companion.mjs` refuses receipt-required `ACP_CMD` without a validated
// execution profile, and `validateExecutionProfile` binds the profile's argv
// to a verified executable. opencode-ai ships NO JS launcher — its bin IS a
// Bun-compiled native binary (measured 2026-11-07 on 1.18.21: `bin/opencode.exe`,
// Mach-O arm64, `--version` -> 1.18.21) — so the profile pins that binary in
// the `node` slot. The slot name is historical (it carried the Node
// interpreter for codex lanes); for a custom worker it carries the agent
// executable, and the receipt's `node_executable_identity` reads accordingly.
// This mapping is stated in `oc-advisor/SKILL.md`, not only here.
//
// PROVENANCE, stated plainly: the digests below are a LOCAL SNAPSHOT of the
// bytes found in this machine's npm cache at production time. They bind what
// actually runs to what was profiled — they are NOT an upstream integrity
// verification of the package (that would need a trusted digest published
// somewhere this repo controls; `resolvePinnedCodexAdapter` has one, this
// does not). What the producer does verify: package name + version, the bin
// target's shape, the binary's own `--version` output, and that multiple
// cache hits agree byte-for-byte before one is chosen.
//
// Usage: node opencode-execution-profile.mjs <output.json>
// Exit 0 prints the matching dispatch variables; 1 is usage; 2 is a refusal.
import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const OPENCODE_PACKAGE_NAME = '@opencode/cli'
export const OPENCODE_PACKAGE_SPEC = '@opencode/cli@2.3.2'
export const OPENCODE_RESOLVED_VERSION = '2.3.2'
// Measured 2026-11-19, live `opencode acp` initialize on v2.3.2:
// agentInfo: { name: 'OpenCode', version: '2.3.2' }. The companion requires
// a pinned expected agent identity for receipt-required custom lanes and
// compares it against the initialize response before the prompt.
export const OPENCODE_EXPECTED_AGENT_INFO = Object.freeze({ name: 'OpenCode', version: '2.3.2' })
const COMPANION_AGENT_INFO = Object.freeze({ name: 'tmux-teams-acp-companion', version: '1' })

const sha256File = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

// The digest the companion recomputes from `profileCore(profile)` — same
// field set, same key order, same hash. If companion and producer ever
// disagree, dispatch fails with `invalid_execution_profile` rather than
// accepting a profile the receipt cannot bind; a test spawns the companion
// against a profile this module built to keep the two honest.
export function profileCoreDigest(profile) {
  const core = {
    schema: profile.schema,
    schema_version: profile.schema_version,
    argv: profile.argv,
    agent_info: profile.agent_info,
    expected_agent_info: profile.expected_agent_info,
    initial_agent_mode: profile.initial_agent_mode,
    adapter: profile.adapter,
    codex: profile.codex,
    node: profile.node,
  }
  return `sha256:${createHash('sha256').update(stableJson(core)).digest('hex')}`
}

/**
 * Extract the semver string from `opencode --version` output.
 * OpenCode 2.x prints `opencode v2.3.2` whereas 1.x printed `1.18.21`.
 */
export function parseOpencodeVersion(output) {
  const first = String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? ''
  if (!first) return ''
  return (first.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/) ?? [])[1] ?? ''
}

function firstVersionLine(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? ''
}

export function npxSlotHash(packageSpec = OPENCODE_PACKAGE_SPEC) {
  return createHash('sha512').update(String(packageSpec)).digest('hex').slice(0, 16)
}

const GATE_NPM_ENV_KEYS = Object.freeze([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
])

export function cleanGateNpmEnv(env = process.env) {
  const out = {}
  for (const key of GATE_NPM_ENV_KEYS) {
    if (typeof env?.[key] === 'string' && env[key].length > 0 && !env[key].includes('\0')) {
      out[key] = env[key]
    }
  }
  return out
}

function cleanProbeEnv(env = process.env, { ignoreAmbientNpmCache = false } = {}) {
  if (ignoreAmbientNpmCache) return cleanGateNpmEnv(env)
  const out = cleanGateNpmEnv(env)
  for (const key of ['NPM_CONFIG_CACHE', 'npm_config_cache']) {
    if (typeof env?.[key] === 'string' && env[key].length > 0 && !env[key].includes('\0')) {
      out[key] = env[key]
    }
  }
  return out
}

function probeNpmConfigDetailed(key, probeEnv, run = spawnSync, npmCommand = 'npm') {
  if (typeof npmCommand !== 'string' || !npmCommand.trim()) {
    return { ok: false, value: '' }
  }
  const probeCwd = mkdtempSync(join(tmpdir(), 'tmux-teams-npm-probe-'))
  try {
    const probe = run(npmCommand, ['config', 'get', key], {
      cwd: probeCwd,
      env: probeEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    if (!probe || probe.error || probe.status !== 0) {
      return { ok: false, value: '' }
    }
    const value = String(probe.stdout ?? '').trim()
    if (!value || value === 'undefined' || value === 'null') {
      return { ok: false, value: '' }
    }
    return { ok: true, value }
  } catch {
    return { ok: false, value: '' }
  } finally {
    try { rmSync(probeCwd, { recursive: true, force: true }) } catch {}
  }
}

export function npmCacheRoots({
  env = process.env,
  run = spawnSync,
  includePlantFallback = true,
  ignoreAmbientNpmCache = false,
  npmCommand = 'npm',
} = {}) {
  const home = env.HOME || env.USERPROFILE || homedir()
  const fromEnv = ignoreAmbientNpmCache ? '' : (env.NPM_CONFIG_CACHE || env.npm_config_cache)
  const probeEnv = cleanProbeEnv(env, { ignoreAmbientNpmCache })
  const cacheProbe = probeNpmConfigDetailed('cache', probeEnv, run, npmCommand)
  const fromNpm = cacheProbe.ok ? cacheProbe.value : ''
  const candidates = ignoreAmbientNpmCache
    ? (fromNpm ? [join(fromNpm, '_npx')] : [])
    : [
        fromEnv ? join(fromEnv, '_npx') : '',
        fromNpm ? join(fromNpm, '_npx') : '',
        home ? join(home, '.npm', '_npx') : '',
      ]
  if (includePlantFallback && home) {
    const plantModules = join(home, '.config', 'tt-gate-plant', 'node_modules')
    if (existsSync(plantModules)) candidates.push(plantModules)
  }
  return [...new Set(candidates.filter(Boolean))]
}

function isSymlinkEntry(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function isRegularDirectoryNoSymlink(path) {
  try {
    const st = lstatSync(path)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function findPackageMetadataFiles(root, packageName) {
  const pkgParts = packageName.split('/').filter(Boolean)
  const found = []
  const direct = join(root, ...pkgParts, 'package.json')
  if (existsSync(direct)) found.push(direct)
  const directModules = join(root, 'node_modules', ...pkgParts, 'package.json')
  if (existsSync(directModules)) found.push(directModules)
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const entryDir = join(root, entry.name)
    if (!isRegularDirectoryNoSymlink(entryDir)) continue
    const nested = join(entryDir, 'node_modules', ...pkgParts, 'package.json')
    if (existsSync(nested)) found.push(nested)
    if (entry.name === '_npx') {
      let npxEntries = []
      try {
        npxEntries = readdirSync(entryDir, { withFileTypes: true })
      } catch {
        npxEntries = []
      }
      for (const hashEntry of npxEntries) {
        if (!hashEntry.isDirectory()) continue
        const hashDir = join(entryDir, hashEntry.name)
        if (!isRegularDirectoryNoSymlink(hashDir)) continue
        const npxNested = join(hashDir, 'node_modules', ...pkgParts, 'package.json')
        if (existsSync(npxNested)) found.push(npxNested)
      }
    }
  }
  return [...new Set(found)]
}

function probeBinaryVersionLine(entryPath, run = spawnSync, env = process.env) {
  try {
    const probe = run(entryPath, ['--version'], {
      env: cleanProbeEnv(env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })
    if (probe?.error || probe?.status !== 0) return ''
    return firstVersionLine(`${probe.stdout ?? ''}\n${probe.stderr ?? ''}`)
  } catch {
    return ''
  }
}

function refuse(reason, code) {
  console.error(`opencode-execution-profile: ${reason}`)
  process.exit(code)
}

function verifyPackageMetadataFile(packagePath, canonicalRoot, {
  packageName,
  expectedVersion,
  verifyBinary,
  probeEnv,
  run,
}) {
  try {
    const metaStat = lstatSync(packagePath)
    if (!metaStat.isFile() || metaStat.isSymbolicLink()) return { drifted: true }
    const packageRoot = realpathSync(dirname(packagePath))
    if (!packageRoot.startsWith(canonicalRoot + sep)) return { drifted: true }
    const raw = readFileSync(packagePath, 'utf8')
    const packageJson = JSON.parse(raw)
    if (packageJson.name !== packageName || packageJson.version !== expectedVersion) return { ignore: true }
    const target = packageJson.bin?.opencode
    if (typeof target !== 'string' || !target || target.startsWith('/') || target.includes('..')) return { drifted: true }
    const candidateEntry = resolve(packageRoot, target)
    if (!candidateEntry.startsWith(packageRoot + sep)) return { drifted: true }
    const entryStat = lstatSync(candidateEntry)
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) return { drifted: true }
    const entryPath = realpathSync(candidateEntry)
    if (!entryPath.startsWith(packageRoot + sep) || !entryPath.startsWith(canonicalRoot + sep) || /\s/.test(entryPath)) {
      return { drifted: true }
    }
    if (process.platform !== 'win32') accessSync(entryPath, fsConstants.X_OK)
    let reportedLine = ''
    if (verifyBinary) {
      const versionProbe = run(entryPath, ['--version'], {
        env: probeEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      })
      reportedLine = firstVersionLine(`${versionProbe?.stdout ?? ''}\n${versionProbe?.stderr ?? ''}`)
      const reportedVersion = parseOpencodeVersion(reportedLine)
      if (versionProbe?.error || versionProbe?.status !== 0 || reportedVersion !== expectedVersion) {
        return { drifted: true }
      }
    }
    return {
      candidate: {
        package_root: packageRoot,
        metadata_path: packagePath,
        metadata_digest: sha256File(packagePath),
        entry_path: entryPath,
        entry_digest: sha256File(entryPath),
        reported_version_line: reportedLine || null,
      },
    }
  } catch {
    return { drifted: true }
  }
}

function driftedCacheResult(searchRoots, packageName, packageSpec) {
  return {
    ok: false,
    code: 'drifted',
    rootsChecked: Object.freeze([...searchRoots]),
    message: `ambiguous or drifted ${packageName} installs in the npm caches — clear them (npx clear-npx-cache or remove the _npx entries) and install ${packageSpec} fresh`,
  }
}

function verifySlotBinBinding(slotDir, entryPath) {
  try {
    const nodeModulesDir = join(slotDir, 'node_modules')
    const binDir = join(nodeModulesDir, '.bin')
    if (!isRegularDirectoryNoSymlink(nodeModulesDir) || !isRegularDirectoryNoSymlink(binDir)) return false
    const binName = process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
    const slotBin = join(binDir, binName)
    if (!existsSync(slotBin)) return false
    if (!statSync(slotBin).isFile()) return false
    if (process.platform !== 'win32') accessSync(slotBin, fsConstants.X_OK)
    return realpathSync(slotBin) === entryPath
  } catch {
    return false
  }
}

function inspectGlobalOpencodeInstall({
  probeEnv,
  run,
  npmCommand,
  packageName,
  expectedVersion,
  verifyBinary,
  pkgParts,
}) {
  const prefixProbe = probeNpmConfigDetailed('prefix', probeEnv, run, npmCommand)
  if (!prefixProbe.ok) return { status: 'unverified' }
  const prefix = prefixProbe.value
  if (!existsSync(prefix)) {
    return isSymlinkEntry(prefix) ? { status: 'drifted' } : { status: 'absent' }
  }
  if (!isRegularDirectoryNoSymlink(prefix)) return { status: 'drifted' }
  try {
    const canonicalPrefix = realpathSync(prefix)
    const globalPkgRoot = process.platform === 'win32'
      ? join(canonicalPrefix, 'node_modules', ...pkgParts)
      : join(canonicalPrefix, 'lib', 'node_modules', ...pkgParts)
    const globalBin = process.platform === 'win32'
      ? join(canonicalPrefix, 'opencode.cmd')
      : join(canonicalPrefix, 'bin', 'opencode')
    const packagePath = join(globalPkgRoot, 'package.json')
    if (!existsSync(packagePath) && !isSymlinkEntry(packagePath)) return { status: 'absent' }
    const verified = verifyPackageMetadataFile(packagePath, canonicalPrefix, {
      packageName, expectedVersion, verifyBinary, probeEnv, run,
    })
    if (verified.drifted) return { status: 'drifted' }
    if (!verified.candidate) return { status: 'absent' }
    if (!existsSync(globalBin)) {
      return isSymlinkEntry(globalBin) ? { status: 'drifted' } : { status: 'absent' }
    }
    if (!statSync(globalBin).isFile()) return { status: 'drifted' }
    if (process.platform !== 'win32') accessSync(globalBin, fsConstants.X_OK)
    if (realpathSync(globalBin) !== verified.candidate.entry_path) return { status: 'drifted' }
    return {
      status: 'matched',
      install: { ...verified.candidate, install_source: 'npm_global' },
    }
  } catch {
    return { status: 'drifted' }
  }
}

/**
 * Inspect npm `_npx` caches (and optional fallback package dirs) for a pinned
 * OpenCode package without calling `process.exit()`. Uses bounded directory
 * reads and enforces symlink/path-escape checks against both canonical root and
 * package root before any binary probe.
 */
export function inspectOpencodeCache({
  roots,
  env = process.env,
  expectedVersion = OPENCODE_RESOLVED_VERSION,
  packageName = OPENCODE_PACKAGE_NAME,
  packageSpec = OPENCODE_PACKAGE_SPEC,
  verifyBinary = true,
  run = spawnSync,
  includePlantFallback = true,
  exactSlotOnly = false,
  ignoreAmbientNpmCache = false,
  includeGlobalPrefix = false,
  npmCommand = 'npm',
} = {}) {
  const probeEnv = cleanProbeEnv(env, { ignoreAmbientNpmCache })
  const expectedSlot = exactSlotOnly ? npxSlotHash(packageSpec) : null
  const pkgParts = packageName.split('/').filter(Boolean)
  const candidates = []
  let drifted = false

  if (exactSlotOnly && includeGlobalPrefix) {
    // Match `libnpmexec` precedence (`libnpmexec/lib/index.js:225`): check the
    // global prefix BEFORE `_npx/<slot>`. If the prefix probe fails or a broken
    // global bin exists, fail closed rather than falling through to `_npx/<slot>`.
    const globalResult = inspectGlobalOpencodeInstall({
      probeEnv,
      run,
      npmCommand,
      packageName,
      expectedVersion,
      verifyBinary,
      pkgParts,
    })
    const initialRoots = Object.freeze(roots ? [...roots] : [])
    if (globalResult.status === 'matched') {
      return {
        ok: true,
        code: 'ok',
        rootsChecked: initialRoots,
        installSource: 'npm_global',
        install: globalResult.install,
      }
    }
    if (globalResult.status === 'drifted') {
      return driftedCacheResult(initialRoots, packageName, packageSpec)
    }
    if (globalResult.status === 'unverified') {
      return {
        ok: false,
        code: 'unverified',
        rootsChecked: initialRoots,
        message: `unable to verify global npm prefix for ${packageName}; refusing to certify _npx cache slot while global precedence is unknown`,
      }
    }
  }

  const searchRoots = roots ?? npmCacheRoots({ env, run, includePlantFallback, ignoreAmbientNpmCache, npmCommand })

  if (exactSlotOnly) {

    for (const root of searchRoots) {
      if (!root) continue
      const absRoot = resolve(root)
      const npxDir = basename(absRoot) === '_npx' ? absRoot : join(absRoot, '_npx')
      if (!existsSync(npxDir)) {
        if (isSymlinkEntry(npxDir)) drifted = true
        continue
      }
      if (!isRegularDirectoryNoSymlink(npxDir)) {
        drifted = true
        continue
      }
      let canonicalNpxRoot
      try {
        canonicalNpxRoot = realpathSync(npxDir)
      } catch {
        drifted = true
        continue
      }
      const slotDir = join(canonicalNpxRoot, expectedSlot)
      if (!isRegularDirectoryNoSymlink(slotDir)) {
        if (existsSync(slotDir) || isSymlinkEntry(slotDir)) drifted = true
        continue
      }
      const packagePath = join(slotDir, 'node_modules', ...pkgParts, 'package.json')
      if (!existsSync(packagePath)) {
        if (isSymlinkEntry(packagePath)) drifted = true
        continue
      }
      const verified = verifyPackageMetadataFile(packagePath, canonicalNpxRoot, {
        packageName, expectedVersion, verifyBinary, probeEnv, run,
      })
      if (verified.drifted) {
        drifted = true
      } else if (verified.candidate) {
        if (verifySlotBinBinding(slotDir, verified.candidate.entry_path)) {
          candidates.push({ ...verified.candidate, install_source: 'npx_slot' })
        } else {
          drifted = true
        }
      }
    }
  } else {
    for (const root of searchRoots) {
      if (!root || !existsSync(root)) continue
      let canonicalRoot
      try {
        canonicalRoot = realpathSync(root)
      } catch {
        drifted = true
        continue
      }
      for (const packagePath of findPackageMetadataFiles(canonicalRoot, packageName)) {
        const verified = verifyPackageMetadataFile(packagePath, canonicalRoot, {
          packageName, expectedVersion, verifyBinary, probeEnv, run,
        })
        if (verified.drifted) drifted = true
        if (verified.candidate) candidates.push({ ...verified.candidate, install_source: 'cache' })
      }
    }
  }
  if (!candidates.length) {
    if (drifted) {
      return driftedCacheResult(searchRoots, packageName, packageSpec)
    }
    return {
      ok: false,
      code: 'missing',
      rootsChecked: Object.freeze([...searchRoots]),
      message: `no verified ${packageName}@${expectedVersion} install in the npm caches (run \`npx -y ${packageSpec} --version\` once, then retry)`,
    }
  }
  const distinct = new Set(candidates.map((candidate) => stableJson({
    metadata_digest: candidate.metadata_digest,
    entry_digest: candidate.entry_digest,
  })))
  if (distinct.size !== 1 || drifted) {
    return driftedCacheResult(searchRoots, packageName, packageSpec)
  }
  const install = candidates.sort((left, right) => left.package_root.localeCompare(right.package_root))[0]
  return {
    ok: true,
    code: 'ok',
    rootsChecked: Object.freeze([...searchRoots]),
    installSource: install.install_source ?? null,
    install,
  }
}

// Resolve ONE byte-identical @opencode/cli@<pinned> install across the npm
// `_npx` caches this machine may hold. Refusals, not picks: zero hits, hits
// that disagree on bytes, a bin target escaping its package, or an
// executable whose own `--version` disagrees with the pin all stop here —
// the profile must never be written from an ambiguous or drifted install.
export function resolveOpencodeInstall({
  roots,
  env = process.env,
  expectedVersion = OPENCODE_RESOLVED_VERSION,
  packageName = OPENCODE_PACKAGE_NAME,
  packageSpec = OPENCODE_PACKAGE_SPEC,
  verifyBinary = true,
  run = spawnSync,
  includePlantFallback = true,
} = {}) {
  const result = inspectOpencodeCache({
    roots,
    env,
    expectedVersion,
    packageName,
    packageSpec,
    verifyBinary,
    run,
    includePlantFallback,
  })
  if (!result.ok) refuse(result.message, 2)
  return result.install
}

export function buildOpencodeProfile({
  metadataPath,
  entryPath,
  version = OPENCODE_RESOLVED_VERSION,
  reportedVersionLine = null,
  expectedAgentInfo = OPENCODE_EXPECTED_AGENT_INFO,
  // Test seam: a fixture profile fed to the real companion validator must be
  // able to name ITS package, or the declared-version check would compare the
  // opencode pin against a fixture's version and refuse for the wrong reason.
  packageSpec = OPENCODE_PACKAGE_SPEC,
  resolvedVersion,
  argvTail = 'acp',
}) {
  const probedVersionLine = reportedVersionLine ?? (version === OPENCODE_RESOLVED_VERSION ? probeBinaryVersionLine(entryPath) : '')
  const nodeVersion = (probedVersionLine && probedVersionLine.trim()) || version
  const profile = {
    schema: 'acp-execution-profile',
    schema_version: 'acp-execution-profile.v1',
    argv: [entryPath, argvTail],
    agent_info: { ...COMPANION_AGENT_INFO },
    // What `opencode acp` MUST report in initialize. The companion compares
    // this against the response before the prompt and fails the dispatch on
    // a mismatch — the receipt never rests on the profile's own word.
    expected_agent_info: { ...expectedAgentInfo },
    // opencode is not measured to honor any INITIAL_AGENT_MODE value, so the
    // profile claims none: the lane's read-only posture rests on
    // ACP_PERMISSIONS=deny and the brief, and says exactly that.
    initial_agent_mode: null,
    adapter: {
      package_spec: packageSpec,
      resolved_version: resolvedVersion ?? version,
      integrity: null,
      metadata_path: metadataPath,
      metadata_digest: sha256File(metadataPath),
      entry_path: null,
      // argv[0] IS the executable and the `node` slot carries its digest;
      // an entry digest here would claim a JS entry file that does not exist.
      entry_digest: null,
    },
    codex: { executable_realpath: null, executable_digest: null, version: 'not_codex' },
    node: { executable_realpath: entryPath, executable_digest: sha256File(entryPath), version: nodeVersion },
    // EXACTLY the ten keys validateExecutionProfile demands (profile_digest
    // included) — no extras. The companion synthesizes
    // `_codex_identity`/`_node_identity` itself from the validated
    // `codex`/`node` slots after reading the file; an extra key here is a
    // guaranteed `invalid_execution_profile` refusal at dispatch.
    profile_digest: null,
  }
  return { ...profile, profile_digest: profileCoreDigest(profile) }
}

function atomicWrite(path, text) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temporary = join(dir, `.${basename(path)}.${process.pid}.tmp`)
  try {
    const fd = openSync(temporary, 'w', 0o600)
    try {
      let offset = 0
      const bytes = Buffer.from(text, 'utf8')
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
  } catch (cause) {
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
    throw cause
  }
}

// Shell-safe single quoting for the printed assignments: a path containing a
// single quote (e.g. /tmp/oc';id;#) must paste as ONE assignment, not close
// the quote and hand the shell a second command. Whitespace is still refused
// outright — the companion's ACP_CMD parser splits on whitespace and no
// quoting can carry a spaced path through it.
function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function main(argv) {
  const [output] = argv
  if (!output) {
    console.error('usage: node opencode-execution-profile.mjs <output.json>')
    process.exit(1)
  }
  if (/\s/.test(output)) {
    // The printed ACP_EXECUTION_PROFILE value is meant to be pasted; the
    // dispatch side reads the path directly, but a whitespace path would
    // make the printed block a lie the paste only discovers later.
    refuse('output path must not contain whitespace', 2)
  }
  const install = resolveOpencodeInstall()
  if (/\s/.test(install.entry_path)) {
    refuse('the resolved opencode executable path contains whitespace, which the dispatch command cannot carry', 2)
  }
  const profile = buildOpencodeProfile({
    metadataPath: install.metadata_path,
    entryPath: install.entry_path,
    reportedVersionLine: install.reported_version_line,
  })
  statSync(install.metadata_path)
  atomicWrite(output, `${JSON.stringify(profile, null, 2)}\n`)
  console.log(`ACP_CMD=${shQuote(`${install.entry_path} acp`)}`)
  console.log(`ACP_EXECUTION_PROFILE=${shQuote(output)}`)
  console.log(`# profile_digest: ${profile.profile_digest}`)
  console.log(`# local snapshot identity of ${OPENCODE_PACKAGE_SPEC} — not an upstream integrity verification`)
}

// Entry-point DETECTION may legitimately fail (argv[1] gone, unreadable) —
// that only means this module was imported, not run. Production must never
// live inside that try: a swallowed write failure was a rc=0 run that
// produced no profile, exactly the false success a paste-then-dispatch
// workflow trusts. Main's own failures exit 2 with the cause on stderr.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  try {
    main(process.argv.slice(2))
  } catch (cause) {
    console.error(`opencode-execution-profile: ${cause?.message ?? cause}`)
    process.exit(2)
  }
}
