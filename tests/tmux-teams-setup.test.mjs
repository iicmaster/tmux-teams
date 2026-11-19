// Tests for tmux-teams-setup: prerequisite verification, pinned installation
// plan/execution, --dry-run precedence, unsafe root refusal, ADR-0007 auth.json
// secret containment, and zero curl|bash guarantees.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BMAD_METHOD_SPEC,
  OPENCODE_SPEC,
  PLUGIN_ROOT,
  SETUP_PROBLEMS,
  checkSetup,
  inspectOpencodeAuth,
  inspectPluginVersions,
  isUnsafeProjectRoot,
  main,
  planInstall,
  runInstall,
} from '../plugins/tmux-teams/skills/tmux-teams-setup/scripts/tmux-teams-setup.mjs'
import { npxSlotHash } from '../plugins/tmux-teams/skills/tmux-teams/scripts/opencode-execution-profile.mjs'
import { resolveExecutable } from '../plugins/tmux-teams/skills/party-mode/scripts/acp-review-client.mjs'
import { buildProfileEnv } from '../plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const isMockNpm = (cmd) => basename(cmd) === 'npm' || basename(cmd) === 'npm-cli.js'
const isMockNpx = (cmd) => basename(cmd) === 'npx' || basename(cmd) === 'npx-cli.js'
const SETUP_SCRIPT = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams-setup', 'scripts', 'tmux-teams-setup.mjs')

function installAuthenticFakeNpm(prefixDir, { nodeBody = 'exit 0', npxBody = 'exit 0', npmBody = 'exit 0' } = {}) {
  const binDir = join(prefixDir, 'bin')
  const npmPkgDir = join(prefixDir, 'lib', 'node_modules', 'npm')
  const npmBinDir = join(npmPkgDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(npmBinDir, { recursive: true })
  writeFileSync(join(npmPkgDir, 'package.json'), JSON.stringify({
    name: 'npm',
    version: '11.19.1',
    bin: { npm: 'bin/npm-cli.js', npx: 'bin/npx-cli.js' },
  }))
  const npmCli = join(npmBinDir, 'npm-cli.js')
  const npxCli = join(npmBinDir, 'npx-cli.js')
  writeFileSync(npmCli, `#!/bin/sh\n${npmBody}\n`)
  writeFileSync(npxCli, `#!/bin/sh\n${npxBody}\n`)
  chmodSync(npmCli, 0o755)
  chmodSync(npxCli, 0o755)
  symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(binDir, 'npm'))
  symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', join(binDir, 'npx'))
  const nodeBin = join(binDir, 'node')
  writeFileSync(nodeBin, `#!/bin/sh\n${nodeBody}\n`)
  chmodSync(nodeBin, 0o755)
  return binDir
}

function makeFakeBinEnv(homeDir, { includeUv = true, includePython = true, pythonVersion = 'Python 3.12.2', includeBundledOptionals = false } = {}) {
  const prefixDir = join(homeDir, '.nvm', 'versions', 'node', 'v24.0.0')
  const binDir = installAuthenticFakeNpm(prefixDir)
  const makeStub = (name, body) => {
    const p = join(binDir, name)
    writeFileSync(p, `#!/bin/sh\n${body}\n`)
    chmodSync(p, 0o755)
  }
  makeStub('git', 'exit 0')
  if (includeBundledOptionals) {
    for (const name of ['bunx', 'tmux']) makeStub(name, 'exit 0')
  }
  if (includeUv) makeStub('uv', 'echo "uv 0.5.0"')
  if (includePython) makeStub('python3', `echo "${pythonVersion}"`)
  return binDir
}

function makeFakeOpencodeCache(cacheRoot, version = '2.3.2', versionLine = `opencode v${version}`, slot = npxSlotHash('@opencode/cli@2.3.2')) {
  const slotDir = join(cacheRoot, '_npx', slot)
  const pkgRoot = join(slotDir, 'node_modules', '@opencode', 'cli')
  const binRoot = join(pkgRoot, 'bin')
  const slotBinDir = join(slotDir, 'node_modules', '.bin')
  mkdirSync(binRoot, { recursive: true })
  mkdirSync(slotBinDir, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: '@opencode/cli',
    version,
    bin: { opencode: 'bin/opencode.exe' },
  }))
  const exe = join(binRoot, 'opencode.exe')
  writeFileSync(exe, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionLine}"; exit 0; fi\n`)
  chmodSync(exe, 0o755)
  symlinkSync('../@opencode/cli/bin/opencode.exe', join(slotBinDir, 'opencode'))
  return pkgRoot
}

test('setup script contains no curl|bash pipeline and uses pinned npm specs', () => {
  const src = readFileSync(SETUP_SCRIPT, 'utf8')
  assert.doesNotMatch(src, /curl[^\n|]*\|\s*(?:ba)?sh/i)
  assert.doesNotMatch(src, /wget[^\n|]*\|\s*(?:ba)?sh/i)
  assert.equal(BMAD_METHOD_SPEC, 'bmad-method@6.12.4')
  assert.equal(OPENCODE_SPEC, '@opencode/cli@2.3.2')
})

test('clean HOME without prerequisites fails check closed and explains missing bmad and opencode', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tmux-teams-setup-clean-'))
  try {
    const home = join(tmp, 'home')
    const proj = join(tmp, 'proj')
    const binDir = makeFakeBinEnv(home, { includeUv: false, includePython: false })
    mkdirSync(home, { recursive: true })
    mkdirSync(proj, { recursive: true })

    const report = checkSetup({
      projectRoot: proj,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: join(tmp, 'empty-npm') },
      inspectCache: () => ({ ok: false, code: 'missing', rootsChecked: [] }),
      run: () => ({ error: { code: 'ENOENT' }, status: null, stdout: '', stderr: '' }),
    })
    assert.equal(report.ok, false)
    assert.equal(report.readyForOpencodeFree, false)
    assert.equal(report.readyForBmadParty, false)
    assert.ok(report.problems.includes('bmad_missing'))
    assert.ok(report.problems.includes('opencode_missing'))
    assert.ok(report.problems.includes('python_runtime_missing'))
    assert.ok(report.warnings.includes('bmad_party_missing'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('missing uv with python3 >= 3.11 is a non-blocking warning and opencode-free is ready without bunx/tmux', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tmux-teams-setup-pyfallback-'))
  try {
    const home = join(tmp, 'home')
    const proj = join(tmp, 'proj')
    const cache = join(tmp, 'npm-cache')
    const binDir = makeFakeBinEnv(home, { includeUv: false, includePython: true, includeBundledOptionals: false })
    makeFakeOpencodeCache(cache, '2.3.2')
    mkdirSync(join(proj, '_bmad'), { recursive: true })
    mkdirSync(join(proj, '.claude', 'skills', 'bmad-party-mode', 'scripts'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py'), '# stub\n')
    mkdirSync(home, { recursive: true })

    const run = (cmd, args) => {
      if (isMockNpm(cmd)) return { status: 0, stdout: cache, stderr: '' }
      if (cmd === 'uv') return { error: { code: 'ENOENT' }, stdout: '', stderr: '' }
      if (cmd === 'python3' && args[0] === '--version') return { status: 0, stdout: 'Python 3.12.4\n', stderr: '' }
      if (cmd === 'opencode') return { error: { code: 'ENOENT' }, stdout: '', stderr: '' }
      if (cmd.endsWith('opencode.exe')) return { status: 0, stdout: 'opencode v2.3.2\n', stderr: '' }
      return { status: 1, stdout: '', stderr: '' }
    }

    const strictPartyReport = checkSetup({
      projectRoot: proj,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run,
    })
    assert.equal(strictPartyReport.readyForOpencodeFree, true)
    assert.equal(strictPartyReport.readyForBmadParty, false, 'project-local party must not mark bmad-party ready without --allow-project-party or global skill')
    assert.equal(strictPartyReport.ok, false)

    const report = checkSetup({
      projectRoot: proj,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run,
      allowProjectParty: true,
    })
    assert.equal(report.ok, true, `problems: ${report.problems.join(',')}`)
    assert.equal(report.readyForOpencodeFree, true)
    assert.equal(report.readyForBmadParty, true)
    assert.equal(report.python.mode, 'python3-fallback')
    assert.ok(report.warnings.includes('uv_missing'))
    assert.ok(!report.problems.includes('python_runtime_missing'))
    assert.equal(report.binaries.ready, true, 'missing optional bunx/tmux must not block plugin readiness')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('--project-root refuses /, $HOME, USERPROFILE, and any path inside plugins/tmux-teams', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tmux-teams-setup-roots-'))
  try {
    const home = join(tmp, 'home')
    const proj = join(home, 'safe-repo')
    mkdirSync(proj, { recursive: true })

    assert.equal(isUnsafeProjectRoot('/', { env: { HOME: home } }), true)
    assert.equal(isUnsafeProjectRoot(home, { env: { HOME: home } }), true)
    assert.equal(isUnsafeProjectRoot(PLUGIN_ROOT, { env: { HOME: home } }), true)
    assert.equal(isUnsafeProjectRoot(join(PLUGIN_ROOT, 'skills', 'tmux-teams'), { env: { HOME: home } }), true)
    assert.equal(isUnsafeProjectRoot(proj, { env: { HOME: home } }), false)

    const out = []
    const code = main(['install', '--yes', '--project-root', home], {
      env: { HOME: home, PATH: process.env.PATH },
      out: (line) => out.push(line),
      err: () => {},
      inspectCache: () => ({ ok: false, code: 'missing', rootsChecked: [] }),
    })
    assert.equal(code, 2)
    assert.match(out.join('\n'), /unsafe_project_root/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('--dry-run always overrides --yes and copies global bmad-party-mode only when absent on --yes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tmux-teams-setup-install-'))
  try {
    const home = join(tmp, 'home')
    const proj = join(tmp, 'proj')
    const binDir = makeFakeBinEnv(home)
    mkdirSync(home, { recursive: true })
    mkdirSync(proj, { recursive: true })

    const executed = []
    const dryPlan = planInstall({
      projectRoot: proj,
      bmad: { hasProjectBmad: false, hasGlobalParty: false, globalPartyDir: join(home, '.claude', 'skills', 'bmad-party-mode') },
      opencode: { cacheOk: false },
      pluginStatus: { needsUpdate: true },
      auth: { status: 'absent' },
      python: { mode: 'uv' },
    }, { projectRoot: proj, env: { HOME: home } })

    assert.equal(dryPlan.ok, true)
    assert.ok(dryPlan.steps.some((s) => s.id === 'install-bmad' && s.args.includes(BMAD_METHOD_SPEC)))
    assert.ok(dryPlan.steps.some((s) => s.id === 'warm-opencode-cache' && s.args.includes(OPENCODE_SPEC)))
    const manualUpdate = dryPlan.steps.find((s) => s.id === 'plugin-update-hint')
    assert.ok(manualUpdate && manualUpdate.kind === 'manual')
    assert.equal(manualUpdate.command.includes('--yes'), false, 'plugin update hint must never forward --yes')

    // Even when both dryRun and yes are true, nothing executes!
    const dryRes = runInstall(dryPlan, {
      dryRun: true,
      yes: true,
      env: { HOME: home, PATH: binDir },
      run: (cmd, args) => { executed.push([cmd, args]); return { status: 0, stdout: '' } },
    })
    assert.equal(dryRes.ok, true)
    assert.equal(dryRes.dryRun, true)
    assert.equal(executed.length, 0)

    // With yes: true and dryRun: false, executes pinned commands with secrets scrubbed,
    // and copies project bmad-party-mode into global ~/.claude/skills ONLY when absent.
    const capturedEnvs = []
    const run = (cmd, args, opts) => {
      executed.push([cmd, args])
      capturedEnvs.push(opts?.env ?? {})
      if (isMockNpx(cmd) && args.includes(BMAD_METHOD_SPEC)) {
        const localParty = join(proj, '.claude', 'skills', 'bmad-party-mode', 'scripts')
        mkdirSync(join(proj, '_bmad'), { recursive: true })
        mkdirSync(localParty, { recursive: true })
        writeFileSync(join(localParty, 'resolve_party.py'), '# installed\n')
      }
      return { status: 0, stdout: 'opencode v2.3.2\n', stderr: '' }
    }
    const execRes = runInstall(dryPlan, {
      dryRun: false,
      yes: true,
      env: {
        HOME: home,
        PATH: binDir,
        NPM_CONFIG_CACHE: join(tmp, 'npm-cache'),
        OPENAI_API_KEY: 'sk-do-not-leak-openai-secret',
        ANTHROPIC_API_KEY: 'sk-ant-do-not-leak-secret',
      },
      run,
      inspectCache: () => ({ ok: true, code: 'ok' }),
    })
    assert.equal(execRes.ok, true)
    assert.equal(execRes.dryRun, false)
    assert.ok(execRes.applied.includes('install-bmad'))
    assert.ok(execRes.applied.includes('copy-global-bmad-party'))
    assert.ok(execRes.applied.includes('warm-opencode-cache'))
    assert.equal(existsSync(join(home, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py')), true)
    for (const childEnv of capturedEnvs) {
      assert.equal('OPENAI_API_KEY' in childEnv, false)
      assert.equal('ANTHROPIC_API_KEY' in childEnv, false)
    }

    // Sentinel test: if global copy already exists, it MUST NOT be overwritten!
    const globalPy = join(home, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py')
    writeFileSync(globalPy, '# user-customized\n')
    runInstall(dryPlan, {
      dryRun: false,
      yes: true,
      env: { HOME: home, PATH: binDir },
      run,
      inspectCache: () => ({ ok: true, code: 'ok' }),
    })
    assert.equal(readFileSync(globalPy, 'utf8'), '# user-customized\n')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('ADR-0007 auth.json secret containment: never leaks tokens, raw JSON errors, or symlink targets', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tmux-teams-setup-auth-'))
  try {
    const SENTINEL = 'opencode-sentinel-secret-9876543210-DO-NOT-PRINT'
    const home = join(tmp, 'home')
    const proj = join(tmp, 'proj')
    const xdgData = join(tmp, 'xdg-data')
    const authDir = join(xdgData, 'opencode')
    mkdirSync(authDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(proj, { recursive: true })

    // Case 1: valid JSON holding a sentinel secret key
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: SENTINEL } }))
    const out1 = []
    main(['check', '--json', '--project-root', proj], {
      env: { HOME: home, XDG_DATA_HOME: xdgData, PATH: '/nonexistent' },
      out: (line) => out1.push(line),
      err: (line) => out1.push(line),
      inspectCache: () => ({ ok: false, code: 'missing', rootsChecked: [] }),
    })
    const combined1 = out1.join('\n')
    assert.equal(combined1.includes(SENTINEL), false, 'sentinel key leaked into CLI output')
    assert.match(combined1, /opencode_auth_key_present/)
    assert.equal(combined1.includes(xdgData), false, 'host XDG_DATA_HOME path leaked instead of constant display path')

    // Case 2: malformed JSON containing sentinel bytes (SyntaxError text must be dropped)
    writeFileSync(join(authDir, 'auth.json'), `{ broken: ${SENTINEL}`)
    const authRes2 = inspectOpencodeAuth({ HOME: home, XDG_DATA_HOME: xdgData })
    assert.equal(authRes2.status, 'invalid')
    assert.equal(authRes2.problem, 'opencode_auth_invalid')
    assert.equal(JSON.stringify(authRes2).includes(SENTINEL), false)

    // Case 3: symlinked auth.json must be flagged invalid without reading target
    rmSync(join(authDir, 'auth.json'))
    const outsideTarget = join(tmp, `secret-target-${SENTINEL}`)
    writeFileSync(outsideTarget, JSON.stringify({ k: SENTINEL }))
    symlinkSync(outsideTarget, join(authDir, 'auth.json'))
    const authRes3 = inspectOpencodeAuth({ HOME: home, XDG_DATA_HOME: xdgData })
    assert.equal(authRes3.status, 'invalid')
    assert.equal(authRes3.problem, 'opencode_auth_invalid')
    assert.equal(JSON.stringify(authRes3).includes(SENTINEL), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('plugin-status detects stale or missing local plugin caches read-only without mutating them', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tmux-teams-setup-caches-'))
  try {
    const home = join(tmp, 'home')
    const claudeCache052 = join(home, '.claude', 'plugins', 'cache', 'tmux-teams', 'tmux-teams', '0.52.0', '.claude-plugin')
    mkdirSync(claudeCache052, { recursive: true })
    writeFileSync(join(claudeCache052, 'plugin.json'), JSON.stringify({ name: 'tmux-teams', version: '0.52.0' }))

    const status = inspectPluginVersions({ env: { HOME: home } })
    const claudeEntry = status.caches.find((c) => c.target === 'claude')
    assert.equal(claudeEntry.status, 'stale')
    assert.equal(claudeEntry.stale, true)
    assert.equal(status.needsUpdate, true)
    assert.equal(SETUP_PROBLEMS.plugin_cache_stale.length > 0, true)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('pre-existing project bmad-party-mode is not auto-promoted without --allow-project-party, --with-profile refuses symlinks safely, failed install exits 2 with FAILED text, and --dry-run skips verifyBinary', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tmux-teams-setup-p6-'))
  try {
    const home = join(tmp, 'home')
    const proj = join(tmp, 'proj')
    const outside = join(tmp, 'outside')
    const cache = join(tmp, 'npm-cache')
    const binDir = makeFakeBinEnv(home, { includeUv: true, includePython: true })
    makeFakeOpencodeCache(cache, '2.3.2')
    mkdirSync(home, { recursive: true })
    mkdirSync(outside, { recursive: true })
    mkdirSync(join(proj, '_bmad'), { recursive: true })
    mkdirSync(join(proj, '.claude', 'skills', 'bmad-party-mode', 'scripts'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py'), '# proj\n')

    const run = () => ({ status: 0, stdout: cache, stderr: '' })
    const report = checkSetup({ projectRoot: proj, env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache }, run })
    const noPromotePlan = planInstall(report, { projectRoot: proj, env: { HOME: home } })
    assert.equal(noPromotePlan.steps.some((s) => s.id === 'copy-global-bmad-party'), false)

    const promotePlan = planInstall(report, { projectRoot: proj, env: { HOME: home }, allowProjectParty: true })
    assert.equal(promotePlan.steps.some((s) => s.id === 'copy-global-bmad-party'), true)

    // --dry-run must pass verifyBinary: false
    const dryVerifyFlags = []
    const dryExit = main(['install', '--dry-run', '--project-root', proj], {
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run,
      inspectCache: (opts) => { dryVerifyFlags.push(opts.verifyBinary); return { ok: true, code: 'ok' } },
      out: () => {},
      err: () => {},
    })
    assert.equal(dryExit, 0)
    assert.deepEqual(dryVerifyFlags, [false])

    // Build clean profilePlan before symlink swap (tests both plan-time refusal and TOCTOU execute-time refusal)
    const profilePlan = planInstall(report, { projectRoot: proj, env: { HOME: home }, withProfile: true })
    assert.equal(profilePlan.ok, true)

    // Plan-time refusal when .tmux-teams is already a symlink escaping project root
    symlinkSync(outside, join(proj, '.tmux-teams'))
    const blockedPlan = planInstall(report, { projectRoot: proj, env: { HOME: home }, withProfile: true })
    assert.equal(blockedPlan.ok, false)
    assert.equal(blockedPlan.code, 'unsafe_project_root')

    // Execute-time (TOCTOU) refusal when .tmux-teams becomes a symlink after planning
    const linkDirRes = runInstall(profilePlan, {
      yes: true,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run,
      inspectCache: () => ({
        ok: true,
        code: 'ok',
        install: { metadata_path: '/tmp/p.json', entry_path: '/tmp/opencode.exe', reported_version_line: 'opencode v2.3.2' },
      }),
      buildProfile: () => ({ ok: true }),
    })
    assert.equal(linkDirRes.ok, false)
    assert.equal(linkDirRes.code, 'profile_write_failed')
    assert.equal(existsSync(join(outside, 'opencode-execution-profile.json')), false)

    // Symlinked profile target inside regular .tmux-teams is also refused
    rmSync(join(proj, '.tmux-teams'))
    mkdirSync(join(proj, '.tmux-teams'), { recursive: true })
    const sentinelFile = join(outside, 'sentinel.txt')
    writeFileSync(sentinelFile, 'keep-me\n')
    symlinkSync(sentinelFile, join(proj, '.tmux-teams', 'opencode-execution-profile.json'))
    const linkFileRes = runInstall(profilePlan, {
      yes: true,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run,
      inspectCache: () => ({
        ok: true,
        code: 'ok',
        install: { metadata_path: '/tmp/p.json', entry_path: '/tmp/opencode.exe', reported_version_line: 'opencode v2.3.2' },
      }),
      buildProfile: () => ({ ok: true }),
    })
    assert.equal(linkFileRes.ok, false)
    assert.equal(linkFileRes.code, 'profile_write_failed')
    assert.equal(readFileSync(sentinelFile, 'utf8'), 'keep-me\n')

    // Regular .tmux-teams writes closed 0600 profile atomically
    rmSync(join(proj, '.tmux-teams', 'opencode-execution-profile.json'))
    mkdirSync(join(home, '.claude', 'skills', 'bmad-party-mode', 'scripts'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py'), '# global\n')
    const okRes = runInstall(profilePlan, {
      yes: true,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run,
      inspectCache: () => ({
        ok: true,
        code: 'ok',
        install: { metadata_path: '/tmp/p.json', entry_path: '/tmp/opencode.exe', reported_version_line: 'opencode v2.3.2' },
      }),
      buildProfile: () => ({ packageSpec: 'opencode@2.3.2' }),
    })
    const profilePath = join(proj, '.tmux-teams', 'opencode-execution-profile.json')
    assert.equal(okRes.ok, true)
    assert.equal(lstatSync(profilePath).isFile(), true)
    assert.equal(statSync(profilePath).mode & 0o777, 0o600)

    // Failed install step prints FAILED (not complete) and returns exit 2
    const emptyProj = join(tmp, 'empty-proj')
    mkdirSync(emptyProj, { recursive: true })
    const outLines = []
    const errLines = []
    const failExit = main(['install', '--yes', '--project-root', emptyProj], {
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      inspectCache: () => ({ ok: false, code: 'missing', rootsChecked: [] }),
      out: (l) => outLines.push(l),
      err: (l) => errLines.push(l),
    })
    assert.equal(failExit, 2)
    assert.match(outLines.join('\n'), /install FAILED/)
    assert.doesNotMatch(outLines.join('\n'), /install complete/)
    assert.match(outLines.join('\n'), /install_failed/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('checkSetup defaults to metadata-only (no opencode binary spawn), planInstall hides HOME from copy steps, fresh copy_dir guards pre-existing/nested symlinks & copy errors, and higher-chain symlink ancestors are refused before profile write', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tmux-teams-setup-r3-'))
  try {
    const home = join(tmp, 'home-secret-segment')
    const proj = join(tmp, 'proj')
    const outside = join(tmp, 'outside')
    const cache = join(tmp, 'npm-cache')
    const binDir = makeFakeBinEnv(home, { includeUv: true, includePython: true })
    makeFakeOpencodeCache(cache, '2.3.2')
    mkdirSync(home, { recursive: true })
    mkdirSync(proj, { recursive: true })
    mkdirSync(outside, { recursive: true })

    // 1. Default checkSetup is metadata-only and does NOT execute opencode or plant fallback
    let opencodeSpawned = false
    let plantFlagSeen = null
    const report = checkSetup({
      projectRoot: proj,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      inspectCache: (opts) => {
        plantFlagSeen = opts.includePlantFallback
        assert.equal(opts.verifyBinary, false)
        return { ok: true, code: 'ok' }
      },
      run: (cmd) => {
        if (String(cmd).includes('opencode')) opencodeSpawned = true
        return { status: 0, stdout: cache, stderr: '' }
      },
    })
    assert.equal(opencodeSpawned, false)
    assert.equal(plantFlagSeen, false)
    assert.equal(report.opencode.verifiedBy, 'metadata')

    // 2. planInstall must not embed HOME path in steps
    const plan = planInstall(report, { projectRoot: proj, env: { HOME: home } })
    assert.equal(JSON.stringify(plan.steps).includes(home), false)

    // 3. copy_dir skips if project already had bmad-party-mode BEFORE install-bmad ran
    const preExistingPartyDir = join(proj, '.claude', 'skills', 'bmad-party-mode', 'scripts')
    mkdirSync(preExistingPartyDir, { recursive: true })
    writeFileSync(join(preExistingPartyDir, 'resolve_party.py'), '# pre-existing untrusted\n')
    const skippedPreExisting = runInstall(plan, {
      yes: true,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run: (cmd, args) => {
        if (isMockNpx(cmd) && args.includes(BMAD_METHOD_SPEC)) mkdirSync(join(proj, '_bmad'), { recursive: true })
        return { status: 0, stdout: cache, stderr: '' }
      },
      inspectCache: () => ({ ok: true, code: 'ok' }),
    })
    assert.equal(skippedPreExisting.applied.includes('copy-global-bmad-party'), false)
    assert.equal(existsSync(join(home, '.claude', 'skills', 'bmad-party-mode')), false)

    // 4. Fresh project with nested symlink inside bmad-party-mode fails with install_failed instead of throwing or copying symlink
    const freshProj = join(tmp, 'fresh-proj')
    mkdirSync(freshProj, { recursive: true })
    const freshPlan = planInstall(
      { ...report, projectRoot: freshProj, bmad: { hasProjectBmad: false, hasGlobalParty: false } },
      { projectRoot: freshProj, env: { HOME: home } },
    )
    const symlinkRes = runInstall(freshPlan, {
      yes: true,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run: (cmd, args) => {
        if (isMockNpx(cmd) && args.includes(BMAD_METHOD_SPEC)) {
          mkdirSync(join(freshProj, '_bmad'), { recursive: true })
          const partyScripts = join(freshProj, '.claude', 'skills', 'bmad-party-mode', 'scripts')
          mkdirSync(partyScripts, { recursive: true })
          writeFileSync(join(partyScripts, 'resolve_party.py'), '# ok\n')
          symlinkSync(outside, join(partyScripts, 'escape-link'))
        }
        return { status: 0, stdout: cache, stderr: '' }
      },
      inspectCache: () => ({ ok: true, code: 'ok' }),
    })
    assert.equal(symlinkRes.ok, false)
    assert.equal(symlinkRes.code, 'install_failed')
    assert.equal(symlinkRes.failedStep, 'copy-global-bmad-party')

    // 5. Higher-chain intermediate symlink ancestor (outside/nested exists) refused before write,
    //    and throwing buildProfile returns profile_write_failed instead of throwing uncaught
    mkdirSync(join(outside, 'nested'), { recursive: true })
    symlinkSync(outside, join(freshProj, 'sublink'))
    const escapeOut = join(freshProj, 'sublink', 'nested', 'out.json')
    const customPlan = planInstall(
      { projectRoot: freshProj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: true } },
      { projectRoot: freshProj, env: { HOME: home }, withProfile: true, profileOut: escapeOut },
    )
    const higherLinkRes = runInstall(customPlan, {
      yes: true,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run: () => ({ status: 0, stdout: cache, stderr: '' }),
      inspectCache: () => ({
        ok: true,
        code: 'ok',
        install: { metadata_path: '/tmp/p.json', entry_path: '/tmp/opencode.exe', reported_version_line: 'opencode v2.3.2' },
      }),
      buildProfile: () => ({ ok: true }),
    })
    assert.equal(higherLinkRes.ok, false)
    assert.equal(higherLinkRes.code, 'profile_write_failed')
    assert.equal(existsSync(join(outside, 'nested', 'out.json')), false)

    const cleanProfilePlan = planInstall(
      { projectRoot: freshProj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: true } },
      { projectRoot: freshProj, env: { HOME: home }, withProfile: true },
    )
    const buildThrowRes = runInstall(cleanProfilePlan, {
      yes: true,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: cache },
      run: () => ({ status: 0, stdout: cache, stderr: '' }),
      inspectCache: () => ({
        ok: true,
        code: 'ok',
        install: { metadata_path: '/tmp/p.json', entry_path: '/tmp/opencode.exe', reported_version_line: 'opencode v2.3.2' },
      }),
      buildProfile: () => { throw new Error('build blew up') },
    })
    assert.equal(buildThrowRes.ok, false)
    assert.equal(buildThrowRes.code, 'profile_write_failed')

    // 6. Non-matching _npx slot fails checkSetup even with matching metadata
    const wrongCache = join(tmp, 'wrong-slot-cache')
    makeFakeOpencodeCache(wrongCache, '2.3.2', 'opencode v2.3.2', 'deadbeef01234567')
    const wrongSlotReport = checkSetup({
      projectRoot: freshProj,
      env: { HOME: home, PATH: binDir },
      run: (cmd) => isMockNpm(cmd) ? { status: 0, stdout: wrongCache, stderr: '' } : { status: 0, stdout: 'uv 0.5.0' },
    })
    assert.equal(wrongSlotReport.readyForOpencodeFree, false)
    assert.ok(wrongSlotReport.problems.includes('opencode_missing'))

    // 7. runInstall runs npx steps from clean temp cwd (never projectRoot) via exact absolute launcher with NPM_CONFIG_CACHE stripped
    const execProj = join(tmp, 'exec-proj')
    mkdirSync(execProj, { recursive: true })
    const execPlan = planInstall(
      { projectRoot: execProj, bmad: { hasProjectBmad: false, hasGlobalParty: false }, opencode: { cacheOk: false } },
      { projectRoot: execProj, env: { HOME: home } },
    )
    const execSeen = []
    runInstall(execPlan, {
      yes: true,
      env: { HOME: home, PATH: binDir, NPM_CONFIG_CACHE: wrongCache },
      run: (cmd, args, opts) => {
        execSeen.push({ cmd, args, cwd: opts?.cwd, env: opts?.env })
        return { status: 0, stdout: cache, stderr: '' }
      },
      inspectCache: () => ({ ok: true, code: 'ok' }),
    })
    assert.equal(execSeen.length >= 2, true)
    for (const call of execSeen.filter((c) => isMockNpx(c.cmd))) {
      assert.equal(isAbsolute(call.cmd), true)
      assert.equal(realpathSync(call.cmd), realpathSync(join(binDir, 'npx')))
      assert.notEqual(call.cwd, execProj)
      assert.notEqual(call.cwd, process.cwd())
      assert.equal('NPM_CONFIG_CACHE' in (call.env ?? {}), false)
    }

    // 8. Partial pre-existing proj/.claude/skills/bmad-party-mode (without resolve_party.py) blocks promotion without --allow-project-party
    const partialProj = join(tmp, 'partial-proj')
    const partialHome = join(tmp, 'partial-home')
    const partialBinDir = makeFakeBinEnv(partialHome)
    mkdirSync(join(partialProj, '.claude', 'skills', 'bmad-party-mode'), { recursive: true })
    mkdirSync(partialHome, { recursive: true })
    const partialPlan = planInstall(
      { projectRoot: partialProj, bmad: { hasProjectBmad: false, hasGlobalParty: false }, opencode: { cacheOk: true } },
      { projectRoot: partialProj, env: { HOME: partialHome } },
    )
    const partialRes = runInstall(partialPlan, {
      yes: true,
      env: { HOME: partialHome, PATH: partialBinDir },
      run: (cmd, args) => {
        if (isMockNpx(cmd) && args.includes(BMAD_METHOD_SPEC)) {
          mkdirSync(join(partialProj, '.claude', 'skills', 'bmad-party-mode', 'scripts'), { recursive: true })
          writeFileSync(join(partialProj, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py'), '# ok\n')
        }
        return { status: 0, stdout: cache, stderr: '' }
      },
      inspectCache: () => ({ ok: true, code: 'ok' }),
    })
    assert.equal(partialRes.applied.includes('copy-global-bmad-party'), false)
    assert.equal(existsSync(join(partialHome, '.claude', 'skills', 'bmad-party-mode')), false)

    // 9. Symlinked proj/_bmad fails install-bmad BEFORE spawning npx
    const symBmadProj = join(tmp, 'sym-bmad-proj')
    mkdirSync(symBmadProj, { recursive: true })
    symlinkSync(outside, join(symBmadProj, '_bmad'))
    let spawnedOnSymBmad = false
    const symBmadPlan = planInstall(
      { projectRoot: symBmadProj, bmad: { hasProjectBmad: false, hasGlobalParty: true }, opencode: { cacheOk: true } },
      { projectRoot: symBmadProj, env: { HOME: home } },
    )
    const symBmadRes = runInstall(symBmadPlan, {
      yes: true,
      env: { HOME: home, PATH: binDir },
      run: () => { spawnedOnSymBmad = true; return { status: 0, stdout: '' } },
      inspectCache: () => ({ ok: true, code: 'ok' }),
    })
    assert.equal(spawnedOnSymBmad, false)
    assert.equal(symBmadRes.ok, false)
    assert.equal(symBmadRes.code, 'install_failed')

    // 10. formatCheckText / CLI check distinguishes metadata verified from live launch readiness
    mkdirSync(join(execProj, '_bmad'), { recursive: true })
    const checkOut = []
    main(['check', '--project-root', execProj], {
      env: { HOME: home, PATH: binDir },
      inspectCache: () => ({ ok: true, code: 'ok' }),
      run: (cmd) => isMockNpm(cmd) ? { status: 0, stdout: cache, stderr: '' } : { status: 0, stdout: 'uv 0.5.0' },
      out: (l) => checkOut.push(l),
      err: () => {},
    })
    assert.match(checkOut.join('\n'), /prerequisite metadata for opencode-free : READY \(metadata only; live launch\/catalog not probed\)/)
    assert.match(checkOut.join('\n'), /metadata verified \(exact _npx slot; live launch\/catalog not probed\)/)

    // 11. checkSetup rejects nested <cache>/_npx/_npx/<slot> when real <cache>/_npx/<slot> is empty
    const nestedCache = join(tmp, 'nested-only-cache')
    const slot = npxSlotHash('@opencode/cli@2.3.2')
    const nestedPkg = join(nestedCache, '_npx', '_npx', slot, 'node_modules', '@opencode', 'cli')
    mkdirSync(join(nestedPkg, 'bin'), { recursive: true })
    writeFileSync(join(nestedPkg, 'package.json'), JSON.stringify({ name: '@opencode/cli', version: '2.3.2', bin: { opencode: 'bin/opencode.exe' } }))
    writeFileSync(join(nestedPkg, 'bin', 'opencode.exe'), '#!/bin/sh\n')
    const nestedReport = checkSetup({
      projectRoot: freshProj,
      env: { HOME: home, PATH: binDir },
      run: (cmd) => isMockNpm(cmd) ? { status: 0, stdout: nestedCache, stderr: '' } : { status: 0, stdout: 'uv 0.5.0' },
    })
    assert.equal(nestedReport.opencode.cacheOk, false)
    assert.ok(nestedReport.problems.includes('opencode_missing'))

    // 12. Mixed-case Npm_Config_Cache is stripped and warm-opencode-cache fails closed if exact slot stays absent
    const warmEnvs = []
    const warmMissPlan = planInstall(
      { projectRoot: execProj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: false } },
      { projectRoot: execProj, env: { HOME: home } },
    )
    const warmMissRes = runInstall(warmMissPlan, {
      yes: true,
      env: { HOME: home, PATH: binDir, Npm_Config_Cache: wrongCache, NPM_CONFIG_REGISTRY: 'https://evil.invalid' },
      run: (_cmd, _args, opts) => {
        warmEnvs.push(opts?.env ?? {})
        return { status: 0, stdout: cache, stderr: '' }
      },
      inspectCache: () => ({ ok: false, code: 'missing', rootsChecked: [] }),
    })
    assert.equal('Npm_Config_Cache' in (warmEnvs[0] ?? {}), false)
    assert.equal('NPM_CONFIG_REGISTRY' in (warmEnvs[0] ?? {}), false)
    assert.equal(warmMissRes.ok, false)
    assert.equal(warmMissRes.code, 'opencode_missing')
    assert.equal(warmMissRes.failedStep, 'warm-opencode-cache')

    // 13. Symlinked proj/.opencode/commands or symlink file inside it refuses install-bmad BEFORE spawning npx
    for (const mode of ['dir', 'file']) {
      const cmdSymProj = join(tmp, `opencode-cmd-sym-${mode}`)
      mkdirSync(join(cmdSymProj, '.opencode'), { recursive: true })
      if (mode === 'dir') {
        symlinkSync(outside, join(cmdSymProj, '.opencode', 'commands'))
      } else {
        mkdirSync(join(cmdSymProj, '.opencode', 'commands'), { recursive: true })
        symlinkSync(outside, join(cmdSymProj, '.opencode', 'commands', 'evil.md'))
      }
      let spawned = false
      const p = planInstall(
        { projectRoot: cmdSymProj, bmad: { hasProjectBmad: false, hasGlobalParty: true }, opencode: { cacheOk: true } },
        { projectRoot: cmdSymProj, env: { HOME: home } },
      )
      const r = runInstall(p, {
        yes: true,
        env: { HOME: home, PATH: binDir },
        run: () => { spawned = true; return { status: 0, stdout: '' } },
        inspectCache: () => ({ ok: true, code: 'ok' }),
      })
      assert.equal(spawned, false, `${mode}: npx must not run when .opencode/commands contains symlink`)
      assert.equal(r.ok, false)
      assert.equal(r.code, 'install_failed')
      assert.equal(r.failedStep, 'install-bmad')
    }

    // 14. Launcher PATH parity: custom ~/.local/bin/npx shim fails check and refuses warm BEFORE spawning even when _npx slot exists;
    //     standard PATH reports npm_npx, accepts verified global npm install, and formats global npm bin cleanly.
    const shimHome = join(tmp, 'shim-home')
    const shimLocalBin = join(shimHome, '.local', 'bin')
    mkdirSync(shimLocalBin, { recursive: true })
    const shimNpx = join(shimLocalBin, 'npx')
    writeFileSync(shimNpx, '#!/bin/sh\nexit 0\n')
    chmodSync(shimNpx, 0o755)
    mkdirSync(join(shimHome, '.claude', 'skills', 'bmad-party-mode', 'scripts'), { recursive: true })
    writeFileSync(join(shimHome, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py'), '# ok\n')
    const shimReport = checkSetup({
      projectRoot: freshProj,
      env: { HOME: shimHome, PATH: binDir },
      run: (cmd, args) => {
        if (isMockNpm(cmd) && args[2] === 'cache') return { status: 0, stdout: cache, stderr: '' }
        return { status: 1, stdout: '', stderr: '' }
      },
    })
    assert.equal(shimReport.opencode.launcherKind, 'custom_shim')
    assert.equal(shimReport.readyForOpencodeFree, false)
    assert.ok(shimReport.problems.includes('opencode_custom_npx_shim'))

    let shimWarmSpawnCount = 0
    const shimWarmPlan = planInstall(
      { projectRoot: freshProj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: false } },
      { projectRoot: freshProj, env: { HOME: shimHome } },
    )
    const shimWarmRes = runInstall(shimWarmPlan, {
      yes: true,
      env: { HOME: shimHome, PATH: binDir },
      run: () => {
        shimWarmSpawnCount += 1
        return { status: 0, stdout: '' }
      },
      inspectCache: () => ({ ok: true, code: 'ok', installSource: 'npx_slot' }),
    })
    assert.equal(shimWarmSpawnCount, 0, 'warm-opencode-cache must refuse custom_shim BEFORE spawning')
    assert.equal(shimWarmRes.ok, false)
    assert.equal(shimWarmRes.code, 'opencode_custom_npx_shim')
    assert.equal(shimWarmRes.failedStep, 'warm-opencode-cache')

    // Case B: standard PATH without custom shim accepts verified npm_global install via libnpmexec global branch
    const emptyNpmCache = join(tmp, 'std-empty-cache')
    const stdPrefix = join(tmp, 'std-global-prefix')
    const stdGlobalPkg = join(stdPrefix, 'lib', 'node_modules', '@opencode', 'cli')
    mkdirSync(join(stdGlobalPkg, 'bin'), { recursive: true })
    mkdirSync(join(stdPrefix, 'bin'), { recursive: true })
    writeFileSync(join(stdGlobalPkg, 'package.json'), JSON.stringify({ name: '@opencode/cli', version: '2.3.2', bin: { opencode: 'bin/opencode.exe' } }))
    writeFileSync(join(stdGlobalPkg, 'bin', 'opencode.exe'), '#!/bin/sh\n')
    chmodSync(join(stdGlobalPkg, 'bin', 'opencode.exe'), 0o755)
    symlinkSync('../lib/node_modules/@opencode/cli/bin/opencode.exe', join(stdPrefix, 'bin', 'opencode'))
    const stdGlobalReport = checkSetup({
      projectRoot: freshProj,
      env: { HOME: home, PATH: binDir },
      run: (cmd, args) => {
        if (isMockNpm(cmd) && args[2] === 'prefix') return { status: 0, stdout: `${stdPrefix}\n`, stderr: '' }
        if (isMockNpm(cmd) && args[2] === 'cache') return { status: 0, stdout: `${emptyNpmCache}\n`, stderr: '' }
        return { status: 0, stdout: 'uv 0.5.0' }
      },
    })
    assert.equal(stdGlobalReport.opencode.launcherKind, 'npm_npx')
    assert.equal(stdGlobalReport.opencode.installSource, 'npm_global')
    assert.equal(stdGlobalReport.opencode.ready, true)
    assert.equal(stdGlobalReport.readyForOpencodeFree, true)

    const globalCheckOut = []
    main(['check', '--project-root', freshProj], {
      env: { HOME: home, PATH: binDir },
      run: (cmd, args) => {
        if (isMockNpm(cmd) && args[2] === 'prefix') return { status: 0, stdout: `${stdPrefix}\n`, stderr: '' }
        if (isMockNpm(cmd) && args[2] === 'cache') return { status: 0, stdout: `${emptyNpmCache}\n`, stderr: '' }
        return { status: 0, stdout: 'uv 0.5.0' }
      },
      out: (l) => globalCheckOut.push(l),
      err: () => {},
    })
    assert.match(globalCheckOut.join('\n'), /metadata verified \(global npm bin; live launch\/catalog not probed\)/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('R6 gate/setup parity: untrusted roots (Homebrew clean HOME, repo-contained npx), stub npx beside stub npm refused pre-spawn, absolute invocation, broken global and missing/wrong slot bin refused', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tmux-teams-setup-r6-')))
  try {
    const home = join(tmp, 'home')
    const proj = join(tmp, 'proj')
    const cache = join(tmp, 'npm-cache')
    mkdirSync(home, { recursive: true })
    mkdirSync(join(proj, '_bmad'), { recursive: true })
    mkdirSync(join(home, '.claude', 'skills', 'bmad-party-mode', 'scripts'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py'), '# global\n')
    makeFakeOpencodeCache(cache, '2.3.2')

    // 1a. Untrusted external prefix outside trusted roots -> gate & checkSetup BOTH refuse (untrusted)
    const externalPrefix = join(tmp, 'external-node')
    const externalBin = installAuthenticFakeNpm(externalPrefix)
    for (const name of ['node', 'git', 'uv', 'python3']) {
      writeFileSync(join(externalBin, name), '#!/bin/sh\nexit 0\n')
      chmodSync(join(externalBin, name), 0o755)
    }
    const untrustedEnv = { HOME: home, PATH: externalBin }
    await assert.rejects(
      () => resolveExecutable('npx', buildProfileEnv('opencode', untrustedEnv), {
        profileId: 'opencode',
        targetRepository: realpathSync(proj),
      }),
      /outside trusted runtime roots/,
    )
    const untrustedReport = checkSetup({
      projectRoot: proj,
      env: untrustedEnv,
      run: () => ({ status: 0, stdout: `${cache}\n`, stderr: '' }),
    })
    assert.equal(untrustedReport.opencode.launcherKind, 'untrusted')
    assert.equal(untrustedReport.readyForOpencodeFree, false)
    assert.equal(untrustedReport.ok, false)
    assert.ok(untrustedReport.problems.includes('opencode_launcher_untrusted'))

    // Refuses both warm-opencode-cache AND install-bmad BEFORE spawning when untrusted
    let untrustedSpawns = 0
    const untrustedWarmPlan = planInstall(
      { projectRoot: proj, bmad: { hasProjectBmad: false, hasGlobalParty: true }, opencode: { cacheOk: false } },
      { projectRoot: proj, env: untrustedEnv },
    )
    const untrustedWarmRes = runInstall(untrustedWarmPlan, {
      yes: true,
      env: untrustedEnv,
      run: () => { untrustedSpawns += 1; return { status: 0, stdout: '' } },
      inspectCache: () => ({ ok: true, code: 'ok' }),
    })
    assert.equal(untrustedSpawns, 0)
    assert.equal(untrustedWarmRes.ok, false)
    assert.equal(untrustedWarmRes.code, 'opencode_launcher_untrusted')
    assert.equal(untrustedWarmRes.failedStep, 'install-bmad')

    // 1b. Host Homebrew + clean HOME parity with real review gate (when Homebrew node@24 exists on this machine)
    if (existsSync('/opt/homebrew/opt/node@24/bin/npx')) {
      const cleanEmptyHome = existsSync('/var/empty') ? '/var/empty' : join(tmp, 'empty-home')
      if (!existsSync(cleanEmptyHome)) mkdirSync(cleanEmptyHome, { recursive: true })
      const brewEnv = { HOME: cleanEmptyHome, PATH: '/opt/homebrew/opt/node@24/bin:/usr/bin:/bin' }
      await assert.rejects(
        () => resolveExecutable('npx', buildProfileEnv('opencode', brewEnv), {
          profileId: 'opencode',
          targetRepository: realpathSync(proj),
        }),
        /outside trusted runtime roots/,
      )
      const brewReport = checkSetup({
        projectRoot: proj,
        env: brewEnv,
        inspectCache: () => ({ ok: true, code: 'ok', installSource: 'npx_slot' }),
        run: () => ({ status: 0, stdout: 'uv 0.5.0\n', stderr: '' }),
      })
      assert.equal(brewReport.opencode.launcherKind, 'untrusted')
      assert.equal(brewReport.readyForOpencodeFree, false)
      assert.equal(brewReport.ok, false)
      assert.ok(brewReport.problems.includes('opencode_launcher_untrusted'))
    }

    // 2. Target-repository containment (proj/bin/npx) -> gate & checkSetup BOTH refuse & runInstall does 0 spawns
    const repoPrefix = join(proj, 'repo-node')
    const repoBin = installAuthenticFakeNpm(repoPrefix)
    for (const name of ['git', 'uv']) {
      writeFileSync(join(repoBin, name), '#!/bin/sh\nexit 0\n')
      chmodSync(join(repoBin, name), 0o755)
    }
    const repoEnv = { HOME: home, PATH: repoBin }
    await assert.rejects(
      () => resolveExecutable('npx', buildProfileEnv('opencode', repoEnv), {
        profileId: 'opencode',
        targetRepository: realpathSync(proj),
      }),
      /inside the target repository/,
    )
    const repoReport = checkSetup({
      projectRoot: proj,
      env: repoEnv,
      run: () => ({ status: 0, stdout: `${cache}\n`, stderr: '' }),
    })
    assert.equal(repoReport.opencode.launcherKind, 'untrusted')
    assert.equal(repoReport.readyForOpencodeFree, false)
    assert.ok(repoReport.problems.includes('opencode_launcher_untrusted'))

    let repoWarmSpawns = 0
    const repoWarmPlan = planInstall(
      { projectRoot: proj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: false } },
      { projectRoot: proj, env: repoEnv },
    )
    const repoWarmRes = runInstall(repoWarmPlan, {
      yes: true,
      env: repoEnv,
      run: () => { repoWarmSpawns += 1; return { status: 0, stdout: '' } },
      inspectCache: () => ({ ok: true, code: 'ok' }),
    })
    assert.equal(repoWarmSpawns, 0)
    assert.equal(repoWarmRes.ok, false)
    assert.equal(repoWarmRes.code, 'opencode_launcher_untrusted')
    assert.equal(repoWarmRes.failedStep, 'warm-opencode-cache')

    // 3. Shell stub npx sitting beside shell stub npm in the SAME trusted directory (<home>/.local/bin)
    //    must classify custom_shim and refuse warm-opencode-cache BEFORE spawning!
    const stubHome = join(tmp, 'stub-same-dir-home')
    const stubLocalBin = join(stubHome, '.local', 'bin')
    mkdirSync(stubLocalBin, { recursive: true })
    mkdirSync(join(stubHome, '.claude', 'skills', 'bmad-party-mode', 'scripts'), { recursive: true })
    writeFileSync(join(stubHome, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py'), '# ok\n')
    for (const name of ['node', 'git', 'npm', 'npx', 'uv']) {
      writeFileSync(join(stubLocalBin, name), '#!/bin/sh\nexit 0\n')
      chmodSync(join(stubLocalBin, name), 0o755)
    }
    const stubReport = checkSetup({
      projectRoot: proj,
      env: { HOME: stubHome, PATH: stubLocalBin },
      run: () => ({ status: 0, stdout: `${cache}\n`, stderr: '' }),
    })
    assert.equal(stubReport.opencode.launcherKind, 'custom_shim')
    assert.equal(stubReport.readyForOpencodeFree, false)
    assert.ok(stubReport.problems.includes('opencode_custom_npx_shim'))

    let stubWarmSpawns = 0
    const stubWarmPlan = planInstall(
      { projectRoot: proj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: false } },
      { projectRoot: proj, env: { HOME: stubHome } },
    )
    const stubWarmRes = runInstall(stubWarmPlan, {
      yes: true,
      env: { HOME: stubHome, PATH: stubLocalBin },
      run: () => { stubWarmSpawns += 1; return { status: 0, stdout: '' } },
      inspectCache: () => ({ ok: true, code: 'ok', installSource: 'npx_slot' }),
    })
    assert.equal(stubWarmSpawns, 0, 'stub npx beside stub npm must refuse BEFORE warm spawn')
    assert.equal(stubWarmRes.ok, false)
    assert.equal(stubWarmRes.code, 'opencode_custom_npx_shim')
    assert.equal(stubWarmRes.failedStep, 'warm-opencode-cache')

    // 4. Authentic npm/npx invokes exact absolute resolved launcher (matching resolveExecutable) & paired npmCommand
    const trustedBin = makeFakeBinEnv(home)
    const authEnv = { HOME: home, PATH: trustedBin }
    const gateResolvedNpx = await resolveExecutable('npx', buildProfileEnv('opencode', authEnv), {
      profileId: 'opencode',
      targetRepository: realpathSync(proj),
    })
    assert.equal(gateResolvedNpx, join(trustedBin, 'npx'))

    const seenCheckNpmCmds = []
    const authReport = checkSetup({
      projectRoot: proj,
      env: authEnv,
      run: (cmd, args) => {
        if (basename(cmd) === 'npm') {
          seenCheckNpmCmds.push(cmd)
          if (args[2] === 'cache') return { status: 0, stdout: `${cache}\n`, stderr: '' }
          return { status: 0, stdout: `${join(tmp, 'no-global')}\n`, stderr: '' }
        }
        return { status: 0, stdout: 'uv 0.5.0\n', stderr: '' }
      },
    })
    assert.equal(authReport.readyForOpencodeFree, true)
    assert.equal(seenCheckNpmCmds.length >= 2, true)
    for (const cmd of seenCheckNpmCmds) assert.equal(cmd, join(trustedBin, 'npm'))

    const freshWarmProj = join(tmp, 'fresh-warm-proj')
    mkdirSync(freshWarmProj, { recursive: true })
    const authWarmPlan = planInstall(
      { projectRoot: freshWarmProj, bmad: { hasProjectBmad: false, hasGlobalParty: true }, opencode: { cacheOk: false } },
      { projectRoot: freshWarmProj, env: { HOME: home } },
    )
    const seenExecCmds = []
    const authWarmRes = runInstall(authWarmPlan, {
      yes: true,
      env: authEnv,
      run: (cmd, args) => {
        seenExecCmds.push(cmd)
        if (basename(cmd) === 'npx' && args.includes(BMAD_METHOD_SPEC)) {
          mkdirSync(join(freshWarmProj, '_bmad'), { recursive: true })
        }
        if (basename(cmd) === 'npm' && args[2] === 'cache') return { status: 0, stdout: `${cache}\n`, stderr: '' }
        if (basename(cmd) === 'npm' && args[2] === 'prefix') return { status: 0, stdout: `${join(tmp, 'no-global')}\n`, stderr: '' }
        return { status: 0, stdout: 'uv 0.5.0\n', stderr: '' }
      },
    })
    assert.equal(authWarmRes.ok, true)
    assert.equal(seenExecCmds.filter((c) => basename(c) === 'npx').every((c) => c === gateResolvedNpx), true)
    assert.equal(seenExecCmds.filter((c) => basename(c) === 'npm').every((c) => c === join(trustedBin, 'npm')), true)

    // 5a. Missing or wrong _npx/<slot>/node_modules/.bin/opencode refuses BOTH checkSetup READY and warm-opencode-cache
    const slotBin = join(cache, '_npx', npxSlotHash('@opencode/cli@2.3.2'), 'node_modules', '.bin', 'opencode')
    rmSync(slotBin)
    const missingSlotBinReport = checkSetup({
      projectRoot: proj,
      env: authEnv,
      run: (cmd, args) => {
        if (basename(cmd) === 'npm' && args[2] === 'cache') return { status: 0, stdout: `${cache}\n`, stderr: '' }
        return { status: 0, stdout: `${join(tmp, 'no-global')}\n`, stderr: '' }
      },
    })
    assert.equal(missingSlotBinReport.readyForOpencodeFree, false)
    assert.ok(missingSlotBinReport.problems.includes('opencode_version_drift'))

    const warmMissingSlotBinRes = runInstall(
      planInstall({ projectRoot: proj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: false } }, { projectRoot: proj, env: { HOME: home } }),
      {
        yes: true,
        env: authEnv,
        run: (cmd, args) => {
          if (basename(cmd) === 'npm' && args[2] === 'cache') return { status: 0, stdout: `${cache}\n`, stderr: '' }
          return { status: 0, stdout: `${join(tmp, 'no-global')}\n`, stderr: '' }
        },
      },
    )
    assert.equal(warmMissingSlotBinRes.ok, false)
    assert.equal(warmMissingSlotBinRes.code, 'opencode_version_drift')
    assert.equal(warmMissingSlotBinRes.failedStep, 'warm-opencode-cache')

    // Wrong .bin/opencode target in slot also refuses both READY and warm success
    const decoySlotBin = join(tmp, 'decoy-slot-opencode')
    writeFileSync(decoySlotBin, '#!/bin/sh\n')
    chmodSync(decoySlotBin, 0o755)
    symlinkSync(decoySlotBin, slotBin)
    const wrongSlotBinReport = checkSetup({
      projectRoot: proj,
      env: authEnv,
      run: (cmd, args) => {
        if (basename(cmd) === 'npm' && args[2] === 'cache') return { status: 0, stdout: `${cache}\n`, stderr: '' }
        return { status: 0, stdout: `${join(tmp, 'no-global')}\n`, stderr: '' }
      },
    })
    assert.equal(wrongSlotBinReport.readyForOpencodeFree, false)
    assert.ok(wrongSlotBinReport.problems.includes('opencode_version_drift'))

    const warmWrongSlotBinRes = runInstall(
      planInstall({ projectRoot: proj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: false } }, { projectRoot: proj, env: { HOME: home } }),
      {
        yes: true,
        env: authEnv,
        run: (cmd, args) => {
          if (basename(cmd) === 'npm' && args[2] === 'cache') return { status: 0, stdout: `${cache}\n`, stderr: '' }
          return { status: 0, stdout: `${join(tmp, 'no-global')}\n`, stderr: '' }
        },
      },
    )
    assert.equal(warmWrongSlotBinRes.ok, false)
    assert.equal(warmWrongSlotBinRes.code, 'opencode_version_drift')
    assert.equal(warmWrongSlotBinRes.failedStep, 'warm-opencode-cache')

    // 5b. Restore valid slot + .bin/opencode, then add a broken global @opencode/cli@2.3.2 install:
    //     global precedes slot -> checkSetup & warm-opencode-cache BOTH refuse READY/success!
    rmSync(slotBin)
    symlinkSync('../@opencode/cli/bin/opencode.exe', slotBin)
    const brokenPrefix = join(tmp, 'broken-global-prefix')
    const brokenGlobalPkg = join(brokenPrefix, 'lib', 'node_modules', '@opencode', 'cli')
    const decoyGlobalBin = join(tmp, 'decoy-global-opencode')
    mkdirSync(join(brokenGlobalPkg, 'bin'), { recursive: true })
    mkdirSync(join(brokenPrefix, 'bin'), { recursive: true })
    writeFileSync(join(brokenGlobalPkg, 'package.json'), JSON.stringify({ name: '@opencode/cli', version: '2.3.2', bin: { opencode: 'bin/opencode.exe' } }))
    writeFileSync(join(brokenGlobalPkg, 'bin', 'opencode.exe'), '#!/bin/sh\n')
    chmodSync(join(brokenGlobalPkg, 'bin', 'opencode.exe'), 0o755)
    writeFileSync(decoyGlobalBin, '#!/bin/sh\n')
    chmodSync(decoyGlobalBin, 0o755)
    symlinkSync(decoyGlobalBin, join(brokenPrefix, 'bin', 'opencode'))

    const brokenGlobalReport = checkSetup({
      projectRoot: proj,
      env: authEnv,
      run: (cmd, args) => {
        if (basename(cmd) === 'npm' && args[2] === 'prefix') return { status: 0, stdout: `${brokenPrefix}\n`, stderr: '' }
        if (basename(cmd) === 'npm' && args[2] === 'cache') return { status: 0, stdout: `${cache}\n`, stderr: '' }
        return { status: 0, stdout: 'uv 0.5.0\n', stderr: '' }
      },
    })
    assert.equal(brokenGlobalReport.readyForOpencodeFree, false)
    assert.ok(brokenGlobalReport.problems.includes('opencode_version_drift'))

    const warmBrokenGlobalRes = runInstall(
      planInstall({ projectRoot: proj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: false } }, { projectRoot: proj, env: { HOME: home } }),
      {
        yes: true,
        env: authEnv,
        run: (cmd, args) => {
          if (basename(cmd) === 'npm' && args[2] === 'prefix') return { status: 0, stdout: `${brokenPrefix}\n`, stderr: '' }
          if (basename(cmd) === 'npm' && args[2] === 'cache') return { status: 0, stdout: `${cache}\n`, stderr: '' }
          return { status: 0, stdout: 'uv 0.5.0\n', stderr: '' }
        },
      },
    )
    assert.equal(warmBrokenGlobalRes.ok, false)
    assert.equal(warmBrokenGlobalRes.code, 'opencode_version_drift')
    assert.equal(warmBrokenGlobalRes.failedStep, 'warm-opencode-cache')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('R7 launcher refusal & failed prefix probe: public check and install --dry-run make 0 npm/npx calls on refusal, and failed prefix probe blocks READY and warm', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tmux-teams-setup-r7-')))
  try {
    const home = join(tmp, 'home')
    const proj = join(tmp, 'proj')
    const cache = join(tmp, 'npm-cache')
    mkdirSync(home, { recursive: true })
    mkdirSync(join(proj, '_bmad'), { recursive: true })
    mkdirSync(join(home, '.claude', 'skills', 'bmad-party-mode', 'scripts'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py'), '# global\n')
    makeFakeOpencodeCache(cache, '2.3.2')

    const extBin = installAuthenticFakeNpm(join(tmp, 'ext-node'))
    for (const name of ['git', 'uv', 'python3']) {
      writeFileSync(join(extBin, name), '#!/bin/sh\nexit 0\n')
      chmodSync(join(extBin, name), 0o755)
    }

    const repoBin = installAuthenticFakeNpm(join(proj, 'repo-node'))
    for (const name of ['git', 'uv']) {
      writeFileSync(join(repoBin, name), '#!/bin/sh\nexit 0\n')
      chmodSync(join(repoBin, name), 0o755)
    }

    const stubHome = join(tmp, 'stub-home')
    const stubLocalBin = join(stubHome, '.local', 'bin')
    mkdirSync(stubLocalBin, { recursive: true })
    mkdirSync(join(stubHome, '.claude', 'skills', 'bmad-party-mode', 'scripts'), { recursive: true })
    writeFileSync(join(stubHome, '.claude', 'skills', 'bmad-party-mode', 'scripts', 'resolve_party.py'), '# ok\n')
    for (const name of ['node', 'git', 'npm', 'npx', 'uv']) {
      writeFileSync(join(stubLocalBin, name), '#!/bin/sh\nexit 0\n')
      chmodSync(join(stubLocalBin, name), 0o755)
    }

    const refusalCases = [
      { label: 'untrusted external prefix', env: { HOME: home, PATH: extBin } },
      { label: 'repo-contained npx', env: { HOME: home, PATH: repoBin } },
      { label: 'stub npx beside stub npm', env: { HOME: stubHome, PATH: stubLocalBin } },
      { label: 'missing npx', env: { HOME: home, PATH: '/nonexistent' } },
    ]
    if (existsSync('/opt/homebrew/opt/node@24/bin/npx')) {
      const cleanHome = existsSync('/var/empty') ? '/var/empty' : join(tmp, 'clean-empty-home')
      if (!existsSync(cleanHome)) mkdirSync(cleanHome, { recursive: true })
      refusalCases.push({
        label: 'homebrew clean HOME',
        env: { HOME: cleanHome, PATH: '/opt/homebrew/opt/node@24/bin:/usr/bin:/bin' },
      })
    }

    for (const { label, env } of refusalCases) {
      const npmOrNpxCalls = []
      const spyRun = (cmd, args) => {
        const name = basename(String(cmd))
        if (name.includes('npm') || name.includes('npx')) {
          npmOrNpxCalls.push([cmd, args])
        }
        return { status: 0, stdout: 'uv 0.5.0\n', stderr: '' }
      }
      const checkExit = main(['check', '--project-root', proj, '--json'], {
        env,
        run: spyRun,
        out: () => {},
        err: () => {},
      })
      const dryExit = main(['install', '--dry-run', '--project-root', proj, '--json'], {
        env,
        run: spyRun,
        out: () => {},
        err: () => {},
      })
      assert.equal(checkExit, 2, `${label}: check must exit 2`)
      assert.equal(dryExit, 0, `${label}: install --dry-run must exit 0`)
      assert.deepEqual(npmOrNpxCalls, [], `${label}: CLI preflight must make 0 npm/npx calls on launcher refusal`)
    }

    // Authentic npm_npx + valid _npx/<slot> with failed/empty `npm config get prefix` MUST refuse READY and warm!
    const trustedBin = makeFakeBinEnv(home)
    const validEnv = { HOME: home, PATH: trustedBin }
    for (const badPrefixProbe of [
      { status: 1, stdout: '', stderr: 'npm config failed' },
      { error: new Error('ETIMEDOUT'), status: null, stdout: '', stderr: '' },
      { status: 0, stdout: '\n', stderr: '' },
    ]) {
      const runWithBrokenPrefix = (cmd, args) => {
        if (basename(cmd) === 'npm') {
          if (args[2] === 'prefix') return badPrefixProbe
          return { status: 0, stdout: `${cache}\n`, stderr: '' }
        }
        return { status: 0, stdout: 'uv 0.5.0\n', stderr: '' }
      }
      const rep = checkSetup({
        projectRoot: proj,
        env: validEnv,
        run: runWithBrokenPrefix,
      })
      assert.equal(rep.opencode.cacheOk, false)
      assert.equal(rep.opencode.cacheCode, 'unverified')
      assert.equal(rep.opencode.ready, false)
      assert.equal(rep.readyForOpencodeFree, false)
      assert.equal(rep.ok, false)
      assert.ok(rep.problems.includes('opencode_prefix_unverified'))

      const warmRes = runInstall(
        planInstall({ projectRoot: proj, bmad: { hasProjectBmad: true, hasGlobalParty: true }, opencode: { cacheOk: false } }, { projectRoot: proj, env: { HOME: home } }),
        {
          yes: true,
          env: validEnv,
          run: runWithBrokenPrefix,
        },
      )
      assert.equal(warmRes.ok, false)
      assert.equal(warmRes.code, 'opencode_prefix_unverified')
      assert.equal(warmRes.failedStep, 'warm-opencode-cache')
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
