// opencode-execution-profile.test.mjs — the producer's own contract. The
// completion round-table (ocadv-complete1) blocked on two defects here: a
// swallowed write failure that exited 0 without producing a profile (B1), and
// printed assignments an apostrophe in a path could break out of (B2). Both
// are pinned at the CLI boundary, because those are the bytes an operator
// pastes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OPENCODE_EXPECTED_AGENT_INFO,
  OPENCODE_PACKAGE_NAME,
  OPENCODE_PACKAGE_SPEC,
  OPENCODE_RESOLVED_VERSION,
  cleanGateNpmEnv,
  inspectOpencodeCache,
  npmCacheRoots,
  npxSlotHash,
  parseOpencodeVersion,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/opencode-execution-profile.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCER = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'opencode-execution-profile.mjs')

function runProducer(...args) {
  const result = spawnSync(process.execPath, [PRODUCER, ...args], { encoding: 'utf8' })
  return { ...result, stdout: result.stdout || '', stderr: result.stderr || '' }
}

// A machine without the pinned install in its npm caches can still prove the
// refusal contract; the happy-path tests below say so by name when they skip.
const probe = runProducer(join(tmpdir(), `ocadv-probe-${Date.now()}.json`))
const INSTALL_RESOLVABLE = probe.status === 0

test('the producer exits 0 only when it produced the profile and printed the dispatch variables', () => {
  if (!INSTALL_RESOLVABLE) {
    assert.equal(probe.status, 2, `an unresolvable install must refuse with exit 2; got ${probe.status}`)
    assert.match(probe.stderr, /no verified @opencode\/cli@2\.3\.2 install/)
    return
  }
  assert.equal(probe.status, 0)
  assert.match(probe.stdout, /^ACP_CMD=/m)
  assert.match(probe.stdout, /^ACP_EXECUTION_PROFILE=/m)
  const profilePath = probe.stdout.match(/^ACP_EXECUTION_PROFILE='(.*)'$/m)?.[1]
  assert.ok(profilePath && existsSync(profilePath), 'exit 0 without a profile on disk is the false success B1 forbids')
  const parsed = JSON.parse(readFileSync(profilePath, 'utf8'))
  assert.equal(parsed.adapter.package_spec, OPENCODE_PACKAGE_SPEC)
  assert.equal(parsed.adapter.resolved_version, OPENCODE_RESOLVED_VERSION)
  assert.deepEqual(parsed.expected_agent_info, OPENCODE_EXPECTED_AGENT_INFO)
  assert.equal(parseOpencodeVersion(parsed.node.version), OPENCODE_RESOLVED_VERSION)
  rmSync(dirname(profilePath) === tmpdir() ? profilePath : dirname(profilePath), { recursive: true, force: true })
})

test('a failed write never exits 0 (B1)', () => {
  // The refusal contract holds everywhere; the false-success shape needs an
  // install to resolve first, because resolution runs before the write.
  if (!INSTALL_RESOLVABLE) {
    assert.equal(probe.status, 2)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'ocadv-b1-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'a file where a directory is needed\n')
  const result = runProducer(join(blocker, 'profile.json'))
  assert.notEqual(result.status, 0, `a swallowed write failure exited 0; stderr:\n${result.stderr}`)
  assert.match(result.stderr, /opencode-execution-profile:/)
  rmSync(dir, { recursive: true, force: true })
})

test('printed assignments survive a single quote in the output path (B2)', () => {
  if (!INSTALL_RESOLVABLE) {
    assert.equal(probe.status, 2)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "ocadv-b2-o'connor-"))
  const result = runProducer(join(dir, "o'profile.json"))
  assert.equal(result.status, 0, `apostrophe path must still succeed; stderr:\n${result.stderr}`)
  const cmdLine = result.stdout.split('\n').find((line) => line.startsWith('ACP_CMD='))
  const profileLine = result.stdout.split('\n').find((line) => line.startsWith('ACP_EXECUTION_PROFILE='))
  assert.ok(cmdLine && profileLine, `printed assignments missing:\n${result.stdout}`)
  // The paste test: the printed lines, sourced by a real shell, must define
  // BOTH variables as single values — not close a quote and run a command.
  const sourced = spawnSync('/bin/sh', ['-c',
    `${cmdLine}\n${profileLine}\nprintf '%s|%s' "$ACP_CMD" "$ACP_EXECUTION_PROFILE"`],
    { encoding: 'utf8' })
  assert.equal(sourced.status, 0, `sourcing the printed block failed:\n${sourced.stderr}`)
  const [cmdValue, profileValue] = (sourced.stdout || '').split('|')
  assert.match(cmdValue, / acp$/, `ACP_CMD did not survive the shell intact: ${cmdValue}`)
  assert.match(profileValue, /o'profile\.json$/, `ACP_EXECUTION_PROFILE did not survive intact: ${profileValue}`)
  rmSync(dir, { recursive: true, force: true })
})

test('a whitespace output path is refused, not quoted around', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocadv-space-'))
  chmodSync(dir, 0o755)
  const result = runProducer(join(dir, 'has space.json'))
  assert.equal(result.status, 2)
  assert.match(result.stderr, /must not contain whitespace/)
  rmSync(dir, { recursive: true, force: true })
})

test('parseOpencodeVersion extracts semver from both 2.x and 1.x output lines', () => {
  assert.equal(parseOpencodeVersion('opencode v2.3.2\n'), '2.3.2')
  assert.equal(parseOpencodeVersion('1.18.21\n'), '1.18.21')
  assert.equal(parseOpencodeVersion('unexpected garbage output\n'), '')
  assert.equal(parseOpencodeVersion(''), '')
  assert.equal(OPENCODE_PACKAGE_NAME, '@opencode/cli')
  assert.equal(OPENCODE_PACKAGE_SPEC, '@opencode/cli@2.3.2')
})

test('inspectOpencodeCache scans bounded _npx directories without spawning binaries on symlink escape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocadv-cache-scan-'))
  try {
    const pkgRoot = join(dir, '_npx', 'abc123', 'node_modules', '@opencode', 'cli')
    mkdirSync(join(pkgRoot, 'bin'), { recursive: true })
    const outsideTarget = join(dir, 'outside-bin')
    writeFileSync(outsideTarget, '#!/bin/sh\necho "opencode v2.3.2"\n')
    chmodSync(outsideTarget, 0o755)
    symlinkSync(outsideTarget, join(pkgRoot, 'bin', 'opencode.exe'))
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
      name: '@opencode/cli',
      version: '2.3.2',
      bin: { opencode: 'bin/opencode.exe' },
    }))
    let executed = 0
    const res = inspectOpencodeCache({
      roots: [dir],
      verifyBinary: true,
      includePlantFallback: false,
      run: () => { executed += 1; return { status: 0, stdout: 'opencode v2.3.2\n' } },
    })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'drifted')
    assert.equal(executed, 0, 'symlinked entry must be rejected BEFORE any binary execution')

    // Intermediate symlinked _npx/<hash> escaping canonical cache root is also rejected before spawn
    const escapeDir = mkdtempSync(join(tmpdir(), 'ocadv-escape-root-'))
    const outsidePkg = join(escapeDir, 'node_modules', '@opencode', 'cli')
    mkdirSync(join(outsidePkg, 'bin'), { recursive: true })
    writeFileSync(join(outsidePkg, 'package.json'), JSON.stringify({
      name: '@opencode/cli',
      version: '2.3.2',
      bin: { opencode: 'bin/opencode.exe' },
    }))
    writeFileSync(join(outsidePkg, 'bin', 'opencode.exe'), '#!/bin/sh\necho "opencode v2.3.2"\n')
    chmodSync(join(outsidePkg, 'bin', 'opencode.exe'), 0o755)
    const linkParentRoot = mkdtempSync(join(tmpdir(), 'ocadv-link-hash-'))
    mkdirSync(join(linkParentRoot, '_npx'), { recursive: true })
    symlinkSync(escapeDir, join(linkParentRoot, '_npx', 'linkedhash'))
    let escapeExecuted = 0
    const escapedRes = inspectOpencodeCache({
      roots: [linkParentRoot],
      verifyBinary: true,
      includePlantFallback: false,
      run: () => { escapeExecuted += 1; return { status: 0, stdout: 'opencode v2.3.2\n' } },
    })
    assert.equal(escapedRes.ok, false)
    assert.equal(escapeExecuted, 0)
    rmSync(escapeDir, { recursive: true, force: true })
    rmSync(linkParentRoot, { recursive: true, force: true })

    // Real regular file succeeds AND strips ambient NPM_TOKEN / OPENAI_API_KEY from binary probe env
    rmSync(join(pkgRoot, 'bin', 'opencode.exe'))
    writeFileSync(join(pkgRoot, 'bin', 'opencode.exe'), '#!/bin/sh\necho "opencode v2.3.2"\n')
    chmodSync(join(pkgRoot, 'bin', 'opencode.exe'), 0o755)
    const capturedEnvs = []
    const okRes = inspectOpencodeCache({
      roots: [dir],
      env: { HOME: dir, PATH: process.env.PATH, NPM_TOKEN: 'secret-npm', OPENAI_API_KEY: 'secret-openai' },
      verifyBinary: true,
      includePlantFallback: false,
      run: (_cmd, _args, opts) => {
        capturedEnvs.push(opts?.env ?? {})
        return { status: 0, stdout: 'opencode v2.3.2\n', stderr: '' }
      },
    })
    assert.equal(okRes.ok, true)
    assert.equal(okRes.install.reported_version_line, 'opencode v2.3.2')
    assert.ok(capturedEnvs.length >= 1)
    for (const probedEnv of capturedEnvs) {
      assert.equal('NPM_TOKEN' in probedEnv, false)
      assert.equal('OPENAI_API_KEY' in probedEnv, false)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('npmCacheRoots probes npm config with non-checkout temp cwd and stripped secrets, and exactSlotOnly enforces libnpmexec slot', () => {
  const home = mkdtempSync(join(tmpdir(), 'ocadv-home-cwd-'))
  try {
    let seenOpts = null
    const roots = npmCacheRoots({
      env: { HOME: home, PATH: '/usr/bin:/bin', NPM_TOKEN: 'secret-npm-token', NPM_CONFIG_CACHE: '/tmp/ambient-cache' },
      includePlantFallback: false,
      ignoreAmbientNpmCache: true,
      run: (_cmd, _args, opts) => {
        seenOpts = opts
        return { status: 0, stdout: `${home}/.npm\n` }
      },
    })
    assert.ok(seenOpts?.cwd && seenOpts.cwd !== process.cwd() && seenOpts.cwd !== home)
    assert.equal('NPM_TOKEN' in (seenOpts?.env ?? {}), false)
    assert.equal('NPM_CONFIG_CACHE' in (seenOpts?.env ?? {}), false)
    assert.equal(roots.includes('/tmp/ambient-cache/_npx'), false)
    assert.ok(roots.includes(join(home, '.npm', '_npx')))

    const slot = npxSlotHash('@opencode/cli@2.3.2')
    assert.match(slot, /^[0-9a-f]{16}$/)
    const cacheRoot = mkdtempSync(join(tmpdir(), 'ocadv-exact-slot-'))
    try {
      const wrongPkg = join(cacheRoot, '_npx', 'deadbeef01234567', 'node_modules', '@opencode', 'cli')
      mkdirSync(join(wrongPkg, 'bin'), { recursive: true })
      writeFileSync(join(wrongPkg, 'package.json'), JSON.stringify({ name: '@opencode/cli', version: '2.3.2', bin: { opencode: 'bin/opencode.exe' } }))
      writeFileSync(join(wrongPkg, 'bin', 'opencode.exe'), '#!/bin/sh\n')

      const miss = inspectOpencodeCache({ roots: [cacheRoot], verifyBinary: false, includePlantFallback: false, exactSlotOnly: true })
      assert.equal(miss.ok, false)

      // Nested _npx/_npx/<slot> must NOT match when roots already points at <cacheRoot>/_npx
      const doubleNestedPkg = join(cacheRoot, '_npx', '_npx', slot, 'node_modules', '@opencode', 'cli')
      mkdirSync(join(doubleNestedPkg, 'bin'), { recursive: true })
      writeFileSync(join(doubleNestedPkg, 'package.json'), JSON.stringify({ name: '@opencode/cli', version: '2.3.2', bin: { opencode: 'bin/opencode.exe' } }))
      writeFileSync(join(doubleNestedPkg, 'bin', 'opencode.exe'), '#!/bin/sh\n')
      const doubleNestedMiss = inspectOpencodeCache({
        roots: [join(cacheRoot, '_npx')],
        verifyBinary: false,
        includePlantFallback: false,
        exactSlotOnly: true,
      })
      assert.equal(doubleNestedMiss.ok, false, 'nested _npx/_npx/<slot> must be rejected when root is <cache>/_npx')

      // cleanGateNpmEnv drops mixed-case Npm_Config_Cache, NPM_CONFIG_REGISTRY, and API secrets
      const clean = cleanGateNpmEnv({
        PATH: '/usr/bin',
        HOME: home,
        TMPDIR: '/tmp',
        Npm_Config_Cache: '/evil/mixed-case',
        NPM_CONFIG_REGISTRY: 'https://evil.invalid',
        OPENAI_API_KEY: 'sk-secret',
      })
      assert.equal('Npm_Config_Cache' in clean, false)
      assert.equal('NPM_CONFIG_REGISTRY' in clean, false)
      assert.equal('OPENAI_API_KEY' in clean, false)
      assert.equal(clean.PATH, '/usr/bin')
      assert.equal(clean.HOME, home)
      assert.equal(clean.TMPDIR, '/tmp')

      const rightPkg = join(cacheRoot, '_npx', slot, 'node_modules', '@opencode', 'cli')
      mkdirSync(join(rightPkg, 'bin'), { recursive: true })
      writeFileSync(join(rightPkg, 'package.json'), JSON.stringify({ name: '@opencode/cli', version: '2.3.2', bin: { opencode: 'bin/opencode.exe' } }))
      writeFileSync(join(rightPkg, 'bin', 'opencode.exe'), '#!/bin/sh\n')

      // Missing execute bit + missing .bin/opencode must refuse READY (drifted)
      const missingBitAndBin = inspectOpencodeCache({ roots: [cacheRoot], verifyBinary: false, includePlantFallback: false, exactSlotOnly: true })
      assert.equal(missingBitAndBin.ok, false)
      assert.equal(missingBitAndBin.code, 'drifted')

      // Wrong .bin/opencode target must also refuse with drifted even when entry has X_OK
      chmodSync(join(rightPkg, 'bin', 'opencode.exe'), 0o755)
      const slotBinDir = join(cacheRoot, '_npx', slot, 'node_modules', '.bin')
      mkdirSync(slotBinDir, { recursive: true })
      const decoyBin = join(cacheRoot, 'decoy-opencode')
      writeFileSync(decoyBin, '#!/bin/sh\n')
      chmodSync(decoyBin, 0o755)
      symlinkSync(decoyBin, join(slotBinDir, 'opencode'))
      const wrongBinTarget = inspectOpencodeCache({ roots: [cacheRoot], verifyBinary: false, includePlantFallback: false, exactSlotOnly: true })
      assert.equal(wrongBinTarget.ok, false)
      assert.equal(wrongBinTarget.code, 'drifted')

      // Valid .bin/opencode -> ../@opencode/cli/bin/opencode.exe + X_OK passes as npx_slot
      rmSync(join(slotBinDir, 'opencode'))
      symlinkSync('../@opencode/cli/bin/opencode.exe', join(slotBinDir, 'opencode'))
      const hit = inspectOpencodeCache({ roots: [cacheRoot], verifyBinary: false, includePlantFallback: false, exactSlotOnly: true })
      assert.equal(hit.ok, true)
      assert.equal(hit.installSource, 'npx_slot')
      assert.equal(hit.install.entry_path.includes(slot), true)

      // Removing execute bit on entry refuses even with verifyBinary: false
      chmodSync(join(rightPkg, 'bin', 'opencode.exe'), 0o644)
      const nonExecEntry = inspectOpencodeCache({ roots: [cacheRoot], verifyBinary: false, includePlantFallback: false, exactSlotOnly: true })
      assert.equal(nonExecEntry.ok, false)
      assert.equal(nonExecEntry.code, 'drifted')
      chmodSync(join(rightPkg, 'bin', 'opencode.exe'), 0o755)

      // Symlinked _npx -> relocated-slots must reject BOTH relocated-slots/<slot> and relocated-slots/_npx/<slot>
      const symCache = mkdtempSync(join(tmpdir(), 'ocadv-sym-npx-cache-'))
      const relocated = mkdtempSync(join(tmpdir(), 'ocadv-relocated-slots-'))
      try {
        for (const rel of [
          join(relocated, slot, 'node_modules', '@opencode', 'cli'),
          join(relocated, '_npx', slot, 'node_modules', '@opencode', 'cli'),
        ]) {
          mkdirSync(join(rel, 'bin'), { recursive: true })
          writeFileSync(join(rel, 'package.json'), JSON.stringify({ name: '@opencode/cli', version: '2.3.2', bin: { opencode: 'bin/opencode.exe' } }))
          writeFileSync(join(rel, 'bin', 'opencode.exe'), '#!/bin/sh\n')
          chmodSync(join(rel, 'bin', 'opencode.exe'), 0o755)
        }
        symlinkSync(relocated, join(symCache, '_npx'))
        for (const rootArg of [symCache, join(symCache, '_npx')]) {
          const symRes = inspectOpencodeCache({
            roots: [rootArg],
            verifyBinary: false,
            includePlantFallback: false,
            exactSlotOnly: true,
          })
          assert.equal(symRes.ok, false)
          assert.equal(symRes.code, 'drifted')
        }
      } finally {
        rmSync(symCache, { recursive: true, force: true })
        rmSync(relocated, { recursive: true, force: true })
      }

      // includeGlobalPrefix matches verified <prefix>/lib/node_modules/@opencode/cli + <prefix>/bin/opencode,
      // and strictly precedes _npx/<slot> just like libnpmexec.
      const emptyCache = mkdtempSync(join(tmpdir(), 'ocadv-empty-cache-'))
      const fakePrefix = mkdtempSync(join(tmpdir(), 'ocadv-global-prefix-'))
      try {
        const globalPkg = join(fakePrefix, 'lib', 'node_modules', '@opencode', 'cli')
        mkdirSync(join(globalPkg, 'bin'), { recursive: true })
        mkdirSync(join(fakePrefix, 'bin'), { recursive: true })
        writeFileSync(join(globalPkg, 'package.json'), JSON.stringify({ name: '@opencode/cli', version: '2.3.2', bin: { opencode: 'bin/opencode.exe' } }))
        writeFileSync(join(globalPkg, 'bin', 'opencode.exe'), '#!/bin/sh\n')
        chmodSync(join(globalPkg, 'bin', 'opencode.exe'), 0o755)
        symlinkSync('../lib/node_modules/@opencode/cli/bin/opencode.exe', join(fakePrefix, 'bin', 'opencode'))
        const seenNpmCmds = []
        const globalHit = inspectOpencodeCache({
          roots: [emptyCache],
          verifyBinary: false,
          includePlantFallback: false,
          exactSlotOnly: true,
          includeGlobalPrefix: true,
          npmCommand: '/paired/bin/npm',
          run: (cmd, args) => {
            seenNpmCmds.push(cmd)
            if (args[2] === 'prefix') return { status: 0, stdout: `${fakePrefix}\n` }
            return { status: 0, stdout: `${emptyCache}\n` }
          },
        })
        assert.equal(globalHit.ok, true)
        assert.equal(globalHit.installSource, 'npm_global')
        assert.equal(seenNpmCmds.includes('/paired/bin/npm'), true)

        // When BOTH valid global and valid _npx/<slot> exist, global takes precedence
        const bothRes = inspectOpencodeCache({
          roots: [cacheRoot],
          verifyBinary: false,
          includePlantFallback: false,
          exactSlotOnly: true,
          includeGlobalPrefix: true,
          run: (_cmd, args) => {
            if (args[2] === 'prefix') return { status: 0, stdout: `${fakePrefix}\n` }
            return { status: 0, stdout: `${cacheRoot}\n` }
          },
        })
        assert.equal(bothRes.ok, true)
        assert.equal(bothRes.installSource, 'npm_global')

        // When global package matches @opencode/cli@2.3.2 but global bin points elsewhere,
        // inspectOpencodeCache MUST return drifted instead of silently falling through to _npx/<slot>
        rmSync(join(fakePrefix, 'bin', 'opencode'))
        symlinkSync(decoyBin, join(fakePrefix, 'bin', 'opencode'))
        const brokenGlobalWithValidSlot = inspectOpencodeCache({
          roots: [cacheRoot],
          verifyBinary: false,
          includePlantFallback: false,
          exactSlotOnly: true,
          includeGlobalPrefix: true,
          run: (_cmd, args) => {
            if (args[2] === 'prefix') return { status: 0, stdout: `${fakePrefix}\n` }
            return { status: 0, stdout: `${cacheRoot}\n` }
          },
        })
        assert.equal(brokenGlobalWithValidSlot.ok, false)
        assert.equal(brokenGlobalWithValidSlot.code, 'drifted')

        // Unrelated global binary without @opencode/cli@2.3.2 in global node_modules falls through to valid _npx/<slot>
        rmSync(join(fakePrefix, 'lib'), { recursive: true, force: true })
        const unrelatedGlobalFallsThrough = inspectOpencodeCache({
          roots: [cacheRoot],
          verifyBinary: false,
          includePlantFallback: false,
          exactSlotOnly: true,
          includeGlobalPrefix: true,
          run: (_cmd, args) => {
            if (args[2] === 'prefix') return { status: 0, stdout: `${fakePrefix}\n` }
            return { status: 0, stdout: `${cacheRoot}\n` }
          },
        })
        assert.equal(unrelatedGlobalFallsThrough.ok, true)
        assert.equal(unrelatedGlobalFallsThrough.installSource, 'npx_slot')

        // Failing or empty `npm config get prefix` MUST fail closed (`unverified`) even with a valid _npx/<slot>
        for (const failedPrefixResult of [
          { status: 1, stdout: '', stderr: 'npm failed' },
          { status: null, error: new Error('ETIMEDOUT'), stdout: '', stderr: '' },
          { status: 0, stdout: '\n', stderr: '' },
          { status: 0, stdout: 'undefined\n', stderr: '' },
        ]) {
          const unverifiedRes = inspectOpencodeCache({
            roots: [cacheRoot],
            verifyBinary: false,
            includePlantFallback: false,
            exactSlotOnly: true,
            includeGlobalPrefix: true,
            run: (_cmd, args) => {
              if (args[2] === 'prefix') return failedPrefixResult
              return { status: 0, stdout: `${cacheRoot}\n` }
            },
          })
          assert.equal(unverifiedRes.ok, false)
          assert.equal(unverifiedRes.code, 'unverified')
        }

        // ignoreAmbientNpmCache returns [] when `npm config get cache` fails instead of guessing ~/.npm/_npx
        const noCacheRoots = npmCacheRoots({
          env: { HOME: home, PATH: '/usr/bin:/bin' },
          includePlantFallback: false,
          ignoreAmbientNpmCache: true,
          run: () => ({ status: 1, stdout: '' }),
        })
        assert.deepEqual(noCacheRoots, [])
      } finally {
        rmSync(emptyCache, { recursive: true, force: true })
        rmSync(fakePrefix, { recursive: true, force: true })
      }
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
