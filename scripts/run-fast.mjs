#!/usr/bin/env node
// run-fast.mjs — explicit inner-loop selection; full remains bare `node --test`.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIRECTORY = join(REPO_ROOT, 'tests')
// Membership is decided by MEASURED time against the 10-second target, not by
// whether a file imports child_process. `loop-occupancy` spawns once and still
// runs in 2.8s, and it is the file that covers the runner's planners — the code
// most often edited here. Excluding the thing you are working on is how an
// inner loop becomes a ritual. `ledger` (8.9s) and `loop-replay` (17.5s) are
// the two that genuinely do not fit; they appear in the full-only list this
// runner prints, so their absence is visible rather than assumed.
// The domain subscribers belong here by the same measured rule: the three of
// them together run in under half a second, they spawn nothing, and they cover
// the slot accounting that is being moved out of `nextStep` — which makes them
// the files most often edited while that work is in flight. They were full-only
// for exactly one run, and the fast tier reported 250 green while touching none
// of them.
const FAST_TEST_FILES = Object.freeze([
  'tests/domain-bus.test.mjs',
  'tests/domain-equivalence.test.mjs',
  'tests/domain-subscribers.test.mjs',
  'tests/docs-paths.test.mjs',
  'tests/graph.test.mjs',
  'tests/loop-occupancy.test.mjs',
  'tests/loop-runner-heartbeat-model.test.mjs',
  'tests/mailbox-dispatch-id.test.mjs',
  'tests/pulse-platform.test.mjs',
  'tests/review-policy.test.mjs',
  'tests/workflow-graph.test.mjs',
])

function discoveredTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) return discoveredTestFiles(entryPath)
    if (!entry.isFile() || !entry.name.endsWith('.test.mjs')) return []
    return [relative(REPO_ROOT, entryPath).split('\\').join('/')]
  })
}

function usage() {
  console.error('usage: node scripts/run-fast.mjs fast')
  console.error('full suite: node --test')
}

const [mode, ...unexpectedArgs] = process.argv.slice(2)
if (mode !== 'fast' || unexpectedArgs.length > 0) {
  usage()
  process.exit(2)
}

const allTestFiles = discoveredTestFiles(TEST_DIRECTORY).sort()
const missingFastFiles = FAST_TEST_FILES.filter((testFile) => !allTestFiles.includes(testFile))
if (missingFastFiles.length > 0) {
  console.error(`fast tier names missing test file(s): ${missingFastFiles.join(', ')}`)
  process.exit(2)
}

const fastSet = new Set(FAST_TEST_FILES)
const fullOnlyTestFiles = allTestFiles.filter((testFile) => !fastSet.has(testFile))
console.log(`[test] fast (${FAST_TEST_FILES.length}): ${FAST_TEST_FILES.join(', ')}`)
console.log(`[test] full-only (${fullOnlyTestFiles.length}): ${fullOnlyTestFiles.join(', ')}`)
console.log(`[test] full tier remains bare node --test over all ${allTestFiles.length} discovered test file(s)`)
console.log(`+ ${process.execPath} --test ${FAST_TEST_FILES.join(' ')}`)

const result = spawnSync(process.execPath, ['--test', ...FAST_TEST_FILES], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`could not start Node test runner: ${result.error.message}`)
  process.exitCode = 1
} else if (result.signal) {
  console.error(`Node test runner ended from signal ${result.signal}`)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
