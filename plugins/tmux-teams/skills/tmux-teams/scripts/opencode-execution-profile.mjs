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
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const OPENCODE_PACKAGE_SPEC = 'opencode-ai@1.18.21'
export const OPENCODE_RESOLVED_VERSION = '1.18.21'
// Measured 2026-11-07, live `opencode acp` initialize on this machine:
// agentInfo: { name: 'OpenCode', version: '1.18.21' }. The companion requires
// a pinned expected agent identity for receipt-required custom lanes and
// compares it against the initialize response before the prompt.
export const OPENCODE_EXPECTED_AGENT_INFO = Object.freeze({ name: 'OpenCode', version: '1.18.21' })
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

function npmCacheRoots() {
  const fromEnv = process.env.NPM_CONFIG_CACHE
  let fromNpm = ''
  const probe = spawnSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (probe.status === 0) fromNpm = probe.stdout.trim()
  return [...new Set([
    fromEnv ? join(fromEnv, '_npx') : '',
    fromNpm ? join(fromNpm, '_npx') : '',
    join(homedir(), '.npm', '_npx'),
  ].filter(Boolean))]
}

function refuse(reason, code) {
  console.error(`opencode-execution-profile: ${reason}`)
  process.exit(code)
}

// Resolve ONE byte-identical opencode-ai@<pinned> install across the npm
// `_npx` caches this machine may hold. Refusals, not picks: zero hits, hits
// that disagree on bytes, a bin target escaping its package, or an
// executable whose own `--version` disagrees with the pin all stop here —
// the profile must never be written from an ambiguous or drifted install.
export function resolveOpencodeInstall({ roots = npmCacheRoots(), expectedVersion = OPENCODE_RESOLVED_VERSION } = {}) {
  const candidates = []
  let drifted = false
  for (const root of roots) {
    if (!existsSync(root)) continue
    const found = spawnSync('find', [root, '-type', 'f', '-path', '*/node_modules/opencode-ai/package.json', '-print'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (found.status !== 0) continue
    for (const packagePath of found.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      try {
        const raw = readFileSync(packagePath, 'utf8')
        const packageJson = JSON.parse(raw)
        if (packageJson.name !== 'opencode-ai' || packageJson.version !== expectedVersion) continue
        const target = packageJson.bin?.opencode
        if (typeof target !== 'string' || !target || target.startsWith('/') || target.includes('..')) { drifted = true; continue }
        const packageRoot = realpathSync(dirname(packagePath))
        const entryPath = realpathSync(join(packageRoot, target))
        if (/\s/.test(entryPath)) { drifted = true; continue }
        const versionProbe = spawnSync(entryPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        const reported = `${versionProbe.stdout ?? ''}`.trim().split(/\r?\n/).find(Boolean) ?? ''
        if (versionProbe.error || versionProbe.status !== 0 || reported !== expectedVersion) { drifted = true; continue }
        const stat = lstatSync(entryPath)
        if (!stat.isFile() || stat.isSymbolicLink()) { drifted = true; continue }
        candidates.push({
          package_root: packageRoot,
          metadata_path: packagePath,
          metadata_digest: sha256File(packagePath),
          entry_path: entryPath,
          entry_digest: sha256File(entryPath),
        })
      } catch {
        drifted = true
      }
    }
  }
  if (!candidates.length) {
    refuse(`no verified opencode-ai@${expectedVersion} install in the npm caches (run \`npx -y ${OPENCODE_PACKAGE_SPEC} --version\` once, then retry)`, 2)
  }
  const distinct = new Set(candidates.map((candidate) => stableJson({
    metadata_digest: candidate.metadata_digest,
    entry_digest: candidate.entry_digest,
  })))
  if (distinct.size !== 1 || drifted) {
    refuse('ambiguous or drifted opencode-ai installs in the npm caches — clear them (npx clear-npx-cache or remove the _npx entries) and install the pinned version fresh', 2)
  }
  return candidates.sort((left, right) => left.package_root.localeCompare(right.package_root))[0]
}

export function buildOpencodeProfile({
  metadataPath,
  entryPath,
  version = OPENCODE_RESOLVED_VERSION,
  expectedAgentInfo = OPENCODE_EXPECTED_AGENT_INFO,
  // Test seam: a fixture profile fed to the real companion validator must be
  // able to name ITS package, or the declared-version check would compare the
  // opencode pin against a fixture's version and refuse for the wrong reason.
  packageSpec = OPENCODE_PACKAGE_SPEC,
  resolvedVersion,
  argvTail = 'acp',
}) {
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
    node: { executable_realpath: entryPath, executable_digest: sha256File(entryPath), version },
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
  const profile = buildOpencodeProfile({ metadataPath: install.metadata_path, entryPath: install.entry_path })
  statSync(install.metadata_path)
  atomicWrite(output, `${JSON.stringify(profile, null, 2)}\n`)
  console.log(`ACP_CMD=${shQuote(`${install.entry_path} acp`)}`)
  console.log(`ACP_EXECUTION_PROFILE=${shQuote(output)}`)
  console.log(`# profile_digest: ${profile.profile_digest}`)
  console.log(`# local snapshot identity of opencode-ai@${OPENCODE_RESOLVED_VERSION} — not an upstream integrity verification`)
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
