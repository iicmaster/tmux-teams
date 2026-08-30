// Drives the real acp-companion.mjs against a mock ACP agent (fixtures/) so the
// live-view rendering and the resume selection are exercised end to end — the
// same shape of proof the rest of this repo prefers over unit fragments.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync as fsMkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, chmodSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPANION = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'acp-companion.mjs')
// Cancellation-ladder deliveries only. Descendant cleanup after the child has
// already settled is a separate fact by contract (README: "keeps … descendant-
// only cleanup delivery separate"), and it has nothing to wait for — demanding
// a `grace` step in front of it is a claim the system never made. The old
// pattern had no `(cancel)` clause, so it caught both and failed on a clean
// tree at v0.13.1.
const CANCEL_LADDER_SIGNAL = /signal (SIGTERM|SIGKILL) (?:direct-child|process-group) delivered \(cancel\)/g
const MOCK = join(HERE, 'fixtures', 'mock-acp-agent.mjs')
const LIVENESS_FIXTURE = join(HERE, 'fixtures', 'acp-liveness-v1.json')
const STARTUP_FIXTURE = join(HERE, 'fixtures', 'acp-liveness-v1-startup.json')
const RECOVERY_FIXTURE = join(HERE, 'fixtures', 'acp-liveness-v1-recovery.json')
const RECEIPT_SCHEMA_FILE = join(HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'references', 'acp-session-receipt-v1.schema.json')
// A machine without `codex` on PATH is a legitimate place to run this suite —
// CI is one, and it is where this line failed: `which` returned nothing,
// `.find(Boolean)` returned undefined, and `realpathSync(undefined)` threw
// during module load, so all 73 tests in this file reported as ONE failure in
// 76ms. The execution-profile tests genuinely attest the real binary's bytes
// and cannot run without it; every other test only passes its path through an
// env var. So resolve it leniently here and let the tests that need it say so
// by name.
// 38 of these tests build an execution profile from this file and check the
// companion's refusals against it — a drifted digest, a shadowed PATH, a
// self-reported version that does not match. That logic is OURS, and CI is
// exactly where it should be exercised, so a missing `codex` must not turn it
// into 38 skips. What the profile actually needs is a real executable file on
// disk whose bytes and `--version` are stable; when the machine has no codex,
// a stand-in satisfies that without pretending to be the vendor's binary.
//
// Named `stand-in-codex`, not `codex`: a digest attributed to a file that is
// not the thing it claims to be is the one lie this suite exists to prevent.
const CODEX_EXECUTABLE = (() => {
  const found = spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/).find(Boolean)
  if (found) return realpathSync(found)
  const dir = fsMkdtempSync(join(tmpdir(), 'acp-standin-codex-'))
  const path = join(dir, 'stand-in-codex')
  writeFileSync(path, '#!/usr/bin/env node\n'
    + "// Stand-in for the Codex CLI: this suite needs a stable executable to digest,\n"
    + "// not the vendor's behaviour. Anything that reaches it beyond --version is a\n"
    + '// test spawning a real session, which is not what these profiles cover.\n'
    + "if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.0.0-stand-in\\n'); process.exit(0) }\n"
    + "process.stderr.write('stand-in-codex was executed; this suite only digests it\\n')\nprocess.exit(1)\n",
    { mode: 0o755 })
  return realpathSync(path)
})()
const CODEX_IS_REAL = Boolean(spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout.trim())
// Said out loud on every run. A suite that quietly substitutes a fixture for the
// thing it names is how a reader comes to believe more was covered than was.
if (!CODEX_IS_REAL) {
  console.error('[acp-companion.test] no codex on PATH — execution-profile tests run against a stand-in executable')
}
const NODE_EXECUTABLE = realpathSync(process.execPath)
const TEST_TMP_ROOT = fsMkdtempSync(join(tmpdir(), 'acp-receipt-suite-'))
const TEST_REPOSITORIES = new Set()
const CONCURRENT_TEST_CASES = []
function mkdtempSync(prefix) {
  const dir = fsMkdtempSync(join(TEST_TMP_ROOT, basename(String(prefix))))
  TEST_REPOSITORIES.add(dir)
  return dir
}
function concurrentTest(name, fn) {
  CONCURRENT_TEST_CASES.push(Object.freeze({ name, fn }))
}
after(() => {
  for (const dir of TEST_REPOSITORIES) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  rmSync(TEST_TMP_ROOT, { recursive: true, force: true })
})
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed'])
const STALL_HISTORY_STATES = new Set(['suspected_stalled', 'stalled', 'recovered', 'cancellation_unavailable'])
const TERMINAL_LIVENESS_STATES = new Set(['completed', 'cancelled', 'failed'])
const DIGEST_FIELDS = ['content_digest', 'output_digest', 'locations_digest']
const HERMETIC_ENV_KEYS = [
  'ACP_AGENT_ID',
  'ACP_MODEL',
  'ACP_REASONING_EFFORT',
  'ACP_EXPECT_MODEL',
  'ACP_EXPECT_REASONING_EFFORT',
  'ACP_TEST_SNAPSHOT_BUDGET_BYTES',
  'ACP_TEST_TERMINAL_PERSISTENCE_FAILURE',
  'ACP_TEST_MUTATE_SETTLEMENT_AFTER_CAPTURE',
  'ACP_TEST_RECEIPT_PERSISTENCE_FAILURE',
  'ACP_TEST_RECEIPT_SERIALIZE_FAILURE',
  'ACP_TEST_RECEIPT_SCHEMA_FAILURE',
  'ACP_TEST_RECEIPT_WRITE_FAILURE',
  'ACP_TEST_RECEIPT_FILE_FSYNC_FAILURE',
  'ACP_TEST_RECEIPT_PUBLISH_FAILURE',
  'ACP_TEST_RECEIPT_DIRECTORY_FSYNC_FAILURE',
  'ACP_TEST_RECEIPT_READBACK_FAILURE',
  'ACP_TEST_RECEIPT_CORRELATION_FAILURE',
  'ACP_TEST_CONTROLLER_SIGNAL_PERSISTENCE_FAILURE',
  'ACP_TEST_RECEIPT_COMMIT_DELAY_MS',
  'ACP_TEST_PROMPT_DELAY_MS',
  'MOCK_ASSERT_RECEIPT_BEFORE_PROMPT',
  'ACP_SESSION_RECEIPT_REQUIRED',
  'ACP_SESSION_OPERATION',
  'ACP_PRIOR_DISPATCH_ID',
  'ACP_PRIOR_RECEIPT_DIGEST',
  'ACP_EXECUTION_PROFILE',
  'CODEX_PATH',
  'NPM_CONFIG_CACHE',
  'ACP_CONTROL_LOG',
  'ACP_TEST_STAGE_FILE',
  'ACP_TEST_GATE_STAGE',
  'ACP_TEST_GATE_RELEASE_FILE',
  'ACP_TEST_GATE_WATCHDOG_MS',
  'MOCK_STDIN_END_DELAY_MS',
  'ACP_PROCESS_REAP_GRACE_MS',
  'ACP_RESUME',
  'INITIAL_AGENT_MODE',
  'TMUX_TEAMS_PHASE',
  // v0.33.0 added this one and did not add it here, so a shell that had run a
  // dispatch by hand carried it into the producer snapshots and turned the bare
  // suite red for a reason no reader could see in the diff.
  'ACP_SPAWN_NONCE',
]

function testEnv(extraEnv = {}) {
  // Every ACP_* key by prefix, then the named non-ACP ones. The list below was
  // by hand and went stale twice in one release — ACP_SPAWN_NONCE turned the
  // bare suite red on a shell that had run a dispatch, and ACP_ENABLE_TERMINAL
  // was still missing after that was patched. The list now only has to hold
  // what the prefix cannot reach.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ACP_')))
  for (const key of HERMETIC_ENV_KEYS) delete env[key]
  Object.assign(env, {
    ACP_CMD: `${NODE_EXECUTABLE} ${MOCK}`,
    CODEX_PATH: CODEX_EXECUTABLE,
    ACP_STALL_POLICY: 'cancel',
    ACP_HARD_TIMEOUT_SEC: '0',
    ACP_CANCEL_GRACE_MS: '100',
    ACP_PROCESS_KILL_GRACE_MS: '20',
    ACP_PROCESS_REAP_GRACE_MS: '250',
    ACP_RESUME: '',
    ...extraEnv,
  })
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === null) delete env[key]
  }
  return env
}

function runAs(agentName, taskId, extraEnv = {}, cwd = mkdtempSync(join(tmpdir(), 'acp-companion-')), timeoutSec = 30) {
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const r = spawnSync('node', [COMPANION, agentName, cwd, taskId, brief, String(timeoutSec)], {
    cwd, encoding: 'utf8',
    env: testEnv(extraEnv),
  })
  return { ...r, cwd, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function run(taskId, extraEnv = {}, cwd = mkdtempSync(join(tmpdir(), 'acp-companion-')), timeoutSec = 30) {
  return runAs('mock', taskId, extraEnv, cwd, timeoutSec)
}

// The one thing kept when the phase subsystem was deleted. A repository that
// was governed by it could not run a raw companion without the controller's
// exact reservation; letting an upgrade quietly turn that into an ungoverned
// repository is the single behaviour change nobody would have seen. It refuses
// instead. Goes red if either refusal is dropped.
// BARE MODE DROPS OAUTH, and for 22 days nothing here knew. The CLI's --help for
// CLAUDE_CODE_SIMPLE=1 says "OAuth and keychain are never read"; since 8a05d6d
// the companion set it for every claude lane, so the operator's own claude.ai
// subscription — whose only credential IS the keychain entry — answered
// "Authentication required" on every dispatch, and four releases of handoffs
// wrote that down as "the keychain is unreachable from a subprocess". Measured
// 2026-08-30: the real binary as a node subprocess authenticates; the same
// binary with CLAUDE_CODE_SIMPLE=1 exits 1 at $0.
//
// Three arms, asserted on the env the CHILD received (MOCK_ENV_DUMP) rather
// than on the companion's source, and each arm is the other's control:
// dropping bare mode entirely passes (a); keeping it unconditional passes (b);
// only the real rule passes all three.
test('the default claude lane is not put in bare mode, because bare mode cannot use a subscription', () => {
  const dumpOf = (taskId, extraEnv) => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-bare-'))
    const dump = join(cwd, 'child-env.json')
    const r = runAs('claude', taskId, { MOCK_ENV_DUMP: dump, ...extraEnv }, cwd)
    assert.ok(existsSync(dump), `the mock never started, so nothing was observed; stderr:\n${r.stderr}`)
    return JSON.parse(readFileSync(dump, 'utf8'))
  }

  // (a) No profile dir: the operator's default login. Bare mode here forbids
  // the only credential that exists.
  const plain = dumpOf('bare-default', { CLAUDE_CONFIG_DIR: '' })
  assert.notEqual(plain.CLAUDE_CODE_SIMPLE, '1',
    'the default claude lane was put in bare mode, which forbids OAuth and keychain — the subscription cannot authenticate')

  // (b) A profile dir: a routed lane whose settings carry a token, which bare
  // mode still reads. The hook-stripping that 8a05d6d wanted must survive here,
  // or "fix auth" quietly became "drop bare mode".
  const routed = dumpOf('bare-routed', { CLAUDE_CONFIG_DIR: '/definitely/nonexistent/profile' })
  assert.equal(routed.CLAUDE_CODE_SIMPLE, '1',
    'a routed lane lost bare mode, so it inherits the repository hooks 8a05d6d removed it from')

  // (c) An explicit operator choice wins over the rule in both directions.
  const forcedOn = dumpOf('bare-forced-on', { CLAUDE_CONFIG_DIR: '', CLAUDE_CODE_SIMPLE: '1' })
  assert.equal(forcedOn.CLAUDE_CODE_SIMPLE, '1', 'an explicit CLAUDE_CODE_SIMPLE=1 was overridden by the default rule')
  const forcedOff = dumpOf('bare-forced-off', { CLAUDE_CONFIG_DIR: '/definitely/nonexistent/profile', CLAUDE_CODE_SIMPLE: '0' })
  assert.equal(forcedOff.CLAUDE_CODE_SIMPLE, '0', 'an explicit CLAUDE_CODE_SIMPLE=0 was overridden by the default rule')
})

test('a repository still carrying a retired phase gate is refused, not silently downgraded', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-retired-gate-'))
  mkdirSync(join(cwd, '.tmux-teams'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'phase-gate.json'), '{"schema":"tmux-teams.phase-gate-marker"}\n')
  const marked = run('task-retired-marker', {}, cwd)
  assert.notEqual(marked.status, 0, `a governed marker must refuse; stdout:\n${marked.stdout}`)
  assert.match(marked.stderr, /PHASE_GATE_RETIRED/)
  assert.match(marked.stderr, /phase-gate\.json/)

  // Stale reservation environment says a caller still believes in an
  // authorization step that is not happening.
  const stray = run('task-retired-env', { TMUX_TEAMS_GATE_DISPATCH_UUID: 'left-over' })
  assert.notEqual(stray.status, 0, `stray gate env must refuse; stdout:\n${stray.stdout}`)
  assert.match(stray.stderr, /PHASE_GATE_RETIRED/)
  assert.match(stray.stderr, /TMUX_TEAMS_GATE_DISPATCH_UUID/)
})

// The adapter used to inherit the whole parent environment, so a wrong or taken
// adapter saw every credential the parent carried — including other lanes'.
// Goes red if adapterEnv stops filtering, and red the other way if the filter
// is tightened until a lane loses what it needs.
test('an adapter sees its own lane credentials and nothing else', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-env-allowlist-'))
  const result = run('task-env-allowlist', {
    ANTHROPIC_API_KEY: 'anthropic-secret',
    OPENAI_API_KEY: 'openai-secret',
    GOOGLE_API_KEY: 'google-secret',
    AWS_SECRET_ACCESS_KEY: 'nothing-here-needs-this',
  }, cwd)
  assert.equal(result.status, 0, result.stderr)
  const seen = JSON.parse(readFileSync(join(cwd, '.adapter-env.json'), 'utf8'))
  // `mock` is not a known lane, so it gets no provider keys at all.
  assert.deepEqual(seen, {
    OPENAI_API_KEY: false,
    ANTHROPIC_API_KEY: false,
    GOOGLE_API_KEY: false,
    AWS_SECRET_ACCESS_KEY: false,
    PATH: true,
    ACP_AGENT_ID: false,
  }, JSON.stringify(seen))
})

test('ACP_ENV_PASSTHROUGH names what the allowlist missed, one variable at a time', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-env-passthrough-'))
  const result = run('task-env-passthrough', {
    AWS_SECRET_ACCESS_KEY: 'deliberately-named',
    ACP_ENV_PASSTHROUGH: 'AWS_SECRET_ACCESS_KEY',
  }, cwd)
  assert.equal(result.status, 0, result.stderr)
  const seen = JSON.parse(readFileSync(join(cwd, '.adapter-env.json'), 'utf8'))
  assert.equal(seen.AWS_SECRET_ACCESS_KEY, true, JSON.stringify(seen))
  assert.equal(seen.OPENAI_API_KEY, false, JSON.stringify(seen))
})

// The outbox is the one file a worker fully controls. Each of these fails if
// the corresponding refusal is taken out of readTerminalOutbox — which is the
// only thing that makes them evidence rather than a record that a test exists.
test('an outbox that is not a regular file is refused rather than read', () => {
  for (const kind of ['symlink', 'fifo']) {
    // The FIFO is made HERE, before the run, and its creation is asserted on
    // its own terms. Setup used to happen inside the agent with its result
    // ignored, so a failed `mkfifo` produced no file at all and this assertion
    // fired on the wording of a "no outbox" error instead — a setup failure
    // wearing the costume of a classification failure. Now a setup failure says
    // so and this assertion can only fire for the reason it was written.
    let cwd
    const extra = { MOCK_OUTBOX_KIND: kind }
    if (kind === 'fifo') {
      cwd = mkdtempSync(join(tmpdir(), 'acp-companion-'))
      mkdirSync(join(cwd, '.mailbox-out'), { recursive: true })
      // Staged OUTSIDE `.mailbox-out`, and moved in by the agent during its
      // turn. Staging it AT the outbox path made `clearStaleOutbox()` refuse it
      // before the prompt was ever sent, so this assertion was matching that
      // refusal's message — the same sentence — while `readTerminalOutbox`, the
      // thing under test, never ran at all. Found by a reviewer who deleted the
      // reader's file-type check and watched this test stay green.
      const staged = join(cwd, 'staged-fifo')
      const made = spawnSync('mkfifo', [staged])
      assert.ok(!made.error && made.status === 0,
        `SETUP: mkfifo failed, so this test never ran: ${made.error?.message ?? `exit ${made.status} ${made.stderr}`}`)
      assert.ok(lstatSync(staged).isFIFO(), 'SETUP: mkfifo made something that is not a FIFO')
      extra.MOCK_FIFO_SOURCE = staged
    }
    const result = run(`task-outbox-${kind}`, extra, cwd, 20)
    assert.notEqual(result.status, 0, `${kind} must fail; stdout:\n${result.stdout}`)
    // The message carries the stderr it is matching against. It carried only
    // the word `fifo`, and when this went red once inside a full-suite run on
    // 2026-08-08 the report said `AssertionError: fifo` — which names the case
    // and nothing about why. A diagnostic that omits the thing being asserted
    // costs a reproduction attempt every time it fires.
    assert.match(result.stderr, /symlink|not a regular file/,
      `${kind}: stderr did not name the file-type refusal:\n${result.stderr.slice(-800)}`)
  }
})

test('an oversize outbox is refused instead of being read into memory', () => {
  const result = run('task-outbox-oversize', { MOCK_OUTBOX_KIND: 'oversize' }, undefined, 20)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /exceeds its bounded size/)
})

test('terminal evidence records the digest of the outbox that was classified', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-outbox-digest-'))
  const result = run('task-outbox-digest', {}, cwd)
  assert.equal(result.status, 0, result.stderr)
  const outbox = readFileSync(join(cwd, '.mailbox-out', 'task-outbox-digest'))
  assert.equal(
    field(eventTexts(cwd)[0] ?? '', 'outbox_digest'),
    `sha256:${createHash('sha256').update(outbox).digest('hex')}`,
  )
})

function eventTexts(cwd) {
  const dir = join(cwd, '.tmux-teams', 'kms', 'events')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => readFileSync(join(dir, f), 'utf8'))
}

function field(text, name) {
  return (text.match(new RegExp(`^${name}: (.+)$`, 'm')) || [, ''])[1]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asyncRun(taskId, extraEnv = {}, cwd = mkdtempSync(join(tmpdir(), 'acp-companion-')), stallSec = 30, agentName = 'mock') {
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const env = testEnv({
    ...extraEnv,
    ACP_TEST_STAGE_FILE: extraEnv.ACP_TEST_STAGE_FILE ?? join(cwd, 'stages.log'),
  })
  const child = spawn('node', [COMPANION, agentName, cwd, taskId, brief, String(stallSec)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return once(child, 'close').then(([status, signal]) => ({
    status, signal, cwd, stdout, stderr,
  }))
}

async function forEachConcurrent(values, concurrency, worker) {
  const laneCount = Math.max(1, Math.min(concurrency, values.length))
  const lanes = Array.from({ length: laneCount }, (_, laneIndex) => (
    values.filter((_, valueIndex) => valueIndex % laneCount === laneIndex)
  ))
  const settled = await Promise.allSettled(lanes.map(async (lane) => {
    for (const value of lane) await worker(value)
  }))
  const failure = settled.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
}

function liveRun(taskId, extraEnv = {}, cwd = mkdtempSync(join(tmpdir(), 'acp-companion-live-')), stallSec = 30, agentName = 'mock') {
  const brief = join(cwd, 'brief.md')
  writeFileSync(brief, 'do the thing\n')
  const env = testEnv({
    ...extraEnv,
    ACP_TEST_STAGE_FILE: extraEnv.ACP_TEST_STAGE_FILE ?? join(cwd, 'stages.log'),
  })
  const child = spawn('node', [COMPANION, agentName, cwd, taskId, brief, String(stallSec)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const completion = once(child, 'close').then(([status, signal]) => ({ status, signal, cwd, stdout, stderr }))
  return { child, completion, cwd }
}

function snapshot(cwd, taskId) {
  return JSON.parse(readFileSync(join(cwd, '.tmux-teams', 'liveness', `${taskId}.json`), 'utf8'))
}

function fixture(name) {
  return JSON.parse(readFileSync(name, 'utf8'))
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  return value
}

function schemaRef(root, ref) {
  return ref.split('/').slice(1).reduce((node, key) => node[key], root)
}

function schemaMatches(schema, value, root = schema) {
  if (schema.$ref) return schemaMatches(schemaRef(root, schema.$ref), value, root)
  if (schema.not && schemaMatches(schema.not, value, root)) return false
  if (schema.const !== undefined && value !== schema.const) return false
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) return false
  if (schema.oneOf && schema.oneOf.filter((candidate) => schemaMatches(candidate, value, root)).length !== 1) return false
  if (schema.allOf && !schema.allOf.every((candidate) => schemaMatches(candidate, value, root))) return false
  if (schema.if) {
    const condition = schemaMatches(schema.if, value, root)
    if (condition && schema.then && !schemaMatches(schema.then, value, root)) return false
    if (!condition && schema.else && !schemaMatches(schema.else, value, root)) return false
  }
  if (schema.type === 'null' && value !== null) return false
  if (schema.type === 'string' && typeof value !== 'string') return false
  if (schema.type === 'integer' && (!Number.isInteger(value))) return false
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return false
  if (schema.type === 'array' && !Array.isArray(value)) return false
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) return false
  if (schema.required && (!value || typeof value !== 'object' || schema.required.some((key) => !Object.hasOwn(value, key)))) return false
  if (schema.type === 'object' && schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return false
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && !schemaMatches(childSchema, value[key], root)) return false
    }
  }
  if (schema.items && Array.isArray(value) && value.some((entry) => !schemaMatches(schema.items, entry, root))) return false
  return true
}

function digest(value) {
  return `sha256:${createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex')}`
}

let executionProfileFixtureIdentity
function fixtureExecutionIdentity() {
  if (executionProfileFixtureIdentity) return executionProfileFixtureIdentity
  const mockBytes = readFileSync(MOCK)
  const codexBytes = readFileSync(CODEX_EXECUTABLE)
  const nodeBytes = readFileSync(NODE_EXECUTABLE)
  executionProfileFixtureIdentity = Object.freeze({
    mockBytes,
    mockIntegrity: `sha512-${createHash('sha512').update(mockBytes).digest('base64')}`,
    mockDigest: digest(mockBytes),
    codexDigest: digest(codexBytes),
    codexVersion: spawnSync(CODEX_EXECUTABLE, ['--version'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0],
    nodeDigest: digest(nodeBytes),
    nodeVersion: spawnSync(NODE_EXECUTABLE, ['--version'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0],
  })
  return executionProfileFixtureIdentity
}

// `argvEntry` lets a profile hash one file and run another. Every fixture here
// set argv[1] and entry_path to the same path, so the case the binding exists
// for was the one case never written.
function writeExecutionProfile(cwd, { argvEntry = MOCK } = {}) {
  const identity = fixtureExecutionIdentity()
  const profile = {
    schema: 'acp-execution-profile',
    schema_version: 'acp-execution-profile.v1',
    argv: [NODE_EXECUTABLE, argvEntry],
    agent_info: { name: 'producer-test-client', version: '1' },
    expected_agent_info: { name: 'mock-acp-agent', version: '1' },
    initial_agent_mode: 'agent-full-access',
    adapter: {
      package_spec: 'producer-test-acp@1.0.0',
      resolved_version: '1.0.0',
      integrity: identity.mockIntegrity,
      metadata_path: null,
      metadata_digest: null,
      entry_path: MOCK,
      entry_digest: identity.mockDigest,
    },
    codex: {
      executable_realpath: CODEX_EXECUTABLE,
      executable_digest: identity.codexDigest,
      version: identity.codexVersion,
    },
    node: {
      executable_realpath: NODE_EXECUTABLE,
      executable_digest: identity.nodeDigest,
      version: identity.nodeVersion,
    },
  }
  profile.profile_digest = digest(JSON.stringify(stableValue(profile)))
  const path = join(cwd, 'acp-execution-profile.json')
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  return path
}

test('a profile that hashes one entry and runs another is refused', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-argv-entry-'))
  // A second, perfectly innocent script. The profile still verifies MOCK's
  // bytes — it just does not run them.
  const other = join(cwd, 'other-adapter.mjs')
  writeFileSync(other, readFileSync(MOCK))
  const profile = writeExecutionProfile(cwd, { argvEntry: other })
  const result = run('task-argv-entry-mismatch', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new',
    ACP_EXECUTION_PROFILE: profile, ACP_CMD: `${NODE_EXECUTABLE} ${other}`,
  }, cwd)
  assert.notEqual(result.status, 0, `mismatch must fail; stdout:\n${result.stdout}`)
  assert.match(result.stderr, /does not run the adapter entry it verified/)
})

function writeBinaryAdapterProfile(cwd, { divergent = false } = {}) {
  const adapterPath = join(cwd, divergent ? 'binary-adapter-divergent.mjs' : 'binary-adapter.mjs')
  const identity = fixtureExecutionIdentity()
  const prefix = Buffer.concat([identity.mockBytes, Buffer.from('\n// binary fixture: NUL and invalid UTF-8 follow ', 'utf8')])
  const suffix = Buffer.from([0x00, 0xff, 0xfe, 0x80])
  const bytes = Buffer.concat([prefix, suffix])
  if (divergent) bytes[bytes.length - 1] = 0x81
  writeFileSync(adapterPath, bytes, { mode: 0o700 })
  chmodSync(adapterPath, 0o700)
  const profile = {
    schema: 'acp-execution-profile',
    schema_version: 'acp-execution-profile.v1',
    argv: [NODE_EXECUTABLE, adapterPath],
    agent_info: { name: 'producer-test-client', version: '1' },
    expected_agent_info: { name: 'mock-acp-agent', version: '1' },
    initial_agent_mode: null,
    adapter: {
      package_spec: 'binary-fixture-acp@1.0.0',
      resolved_version: '1.0.0',
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      metadata_path: null,
      metadata_digest: null,
      entry_path: adapterPath,
      entry_digest: digest(bytes),
    },
    codex: {
      executable_realpath: CODEX_EXECUTABLE,
      executable_digest: identity.codexDigest,
      version: identity.codexVersion,
    },
    node: {
      executable_realpath: NODE_EXECUTABLE,
      executable_digest: identity.nodeDigest,
      version: identity.nodeVersion,
    },
  }
  profile.profile_digest = digest(JSON.stringify(stableValue(profile)))
  const profilePath = join(cwd, `${basename(adapterPath)}.profile.json`)
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  return { adapterPath, profilePath, bytes, profile }
}

function writeExecutable(path, text = '#!/bin/sh\nexit 0\n') {
  writeFileSync(path, text, { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

function receipt(cwd) {
  const dir = join(cwd, '.tmux-teams', 'receipts')
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []
  assert.equal(names.length, 1, `expected one immutable receipt, found ${names.join(', ')}`)
  const raw = readFileSync(join(dir, names[0]), 'utf8')
  return { raw, value: JSON.parse(raw), path: join(dir, names[0]) }
}

function receiptFor(cwd, dispatchId) {
  const path = join(cwd, '.tmux-teams', 'receipts', `${dispatchId}.json`)
  const raw = readFileSync(path, 'utf8')
  return { raw, value: JSON.parse(raw), path }
}

function rewritePriorReceiptPair(cwd, dispatchId, mutate) {
  const prior = receiptFor(cwd, dispatchId)
  const value = mutate({ ...prior.value })
  const raw = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(prior.path, raw, { mode: 0o600 })
  const commitmentPath = join(cwd, '.tmux-teams', 'receipt-commits', `${dispatchId}.json`)
  writeFileSync(commitmentPath, `${JSON.stringify({
    schema: 'acp-session-receipt-commit',
    schema_version: 'acp-session-receipt-commit.v1',
    dispatch_id: dispatchId,
    receipt_digest: digest(raw),
    committed_state: 'committed',
  }, null, 2)}\n`, { mode: 0o600 })
  return { raw, value }
}

const DYNAMIC_COUNT_KEYS = new Set([
  'meaningful_progress_count',
  'consecutive_missed_leases',
  'stall_recoveries',
  'plan_entry_count',
  'update_count',
])

function normalizeFixtureSnapshot(value, key = '') {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((entry) => normalizeFixtureSnapshot(entry, key))
  if (typeof value !== 'object') {
    if (['task_id', 'dispatch_id', 'session_id'].includes(key)) return '<identifier>'
    if (key.endsWith('_at')) return '<timestamp>'
    if (key.endsWith('_digest')) return value === null ? null : '<digest>'
    if (DYNAMIC_COUNT_KEYS.has(key)) return '<count>'
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    normalizeFixtureSnapshot(childValue, childKey),
  ]))
}

function assertIso(value, label) {
  assert.equal(typeof value, 'string', `${label} should be a string timestamp`)
  assert.ok(Number.isFinite(Date.parse(value)), `${label} should be an ISO timestamp`)
}

function assertToolRecord(tool, label) {
  assert.equal(typeof tool.tool_call_id, 'string', `${label}.tool_call_id`)
  assert.ok(tool.tool_call_id.length <= 128, `${label}.tool_call_id is bounded`)
  assert.equal(typeof tool.title, 'string', `${label}.title`)
  assert.ok(tool.title.length <= 128, `${label}.title is bounded`)
  assert.equal(typeof tool.kind, 'string', `${label}.kind`)
  assert.ok(tool.kind.length <= 64, `${label}.kind is bounded`)
  assert.ok(TOOL_STATUSES.has(tool.status), `${label}.status is an ACP v1 value`)
  for (const fieldName of DIGEST_FIELDS) {
    if (tool[fieldName] !== undefined) assert.match(tool[fieldName], /^sha256:[0-9a-f]{64}$/, `${label}.${fieldName}`)
  }
  assertIso(tool.updated_at, `${label}.updated_at`)
  assert.ok(Number.isSafeInteger(tool.update_count) && tool.update_count >= 1, `${label}.update_count`)
}

function assertV1Semantics(value, { expectedState, expectCancellationUnavailable } = {}) {
  assert.equal(value.schema_version, 'acp-liveness.v1')
  assert.equal(Object.hasOwn(value, 'state'), false)
  assert.ok(value.task_id.length <= 64)
  assert.ok(value.dispatch_id.length <= 64)
  assert.ok(value.worker.length <= 64)
  assert.ok(value.session_id === null || value.session_id.length <= 128)
  assert.ok(value.requested_model === null || value.requested_model.length <= 128)
  assert.ok(value.requested_reasoning_effort === null || value.requested_reasoning_effort.length <= 64)
  assert.ok(value.effective_identity === null || value.effective_identity.length <= 194)
  if (value.agent_id) assert.ok(value.agent_id.length <= 64)
  assert.ok(value.termination_reason.length <= 64)
  assertIso(value.started_at, 'started_at')
  assertIso(value.observed_at, 'observed_at')
  assertIso(value.last_protocol_activity_at, 'last_protocol_activity_at')
  assertIso(value.last_meaningful_progress_at, 'last_meaningful_progress_at')
  assertIso(value.lease_anchor_at, 'lease_anchor_at')
  assertIso(value.next_lease_expiry_at, 'next_lease_expiry_at')
  assert.ok(Date.parse(value.started_at) <= Date.parse(value.observed_at))
  const leaseDelta = Date.parse(value.next_lease_expiry_at) - Date.parse(value.lease_anchor_at)
  const hasOpenReportedTool = Object.values(value.tools ?? {}).some((tool) => tool.status === 'in_progress')
  if ((value.liveness_state === 'tool_running' && value.active_tools?.length > 0)
    || hasOpenReportedTool || TERMINAL_LIVENESS_STATES.has(value.liveness_state)) {
    assert.ok(leaseDelta >= value.stall_sec * 1000, 'active tool lease may be extended from a later observation')
  } else {
    assert.equal(leaseDelta, value.stall_sec * 1000, 'lease expiry must be derived from its anchor and stall lease')
  }
  assert.ok(Array.isArray(value.stall_history) && value.stall_history.length <= 32)
  for (const [index, event] of value.stall_history.entries()) {
    assert.ok(STALL_HISTORY_STATES.has(event.state), `stall_history[${index}] state is closed`)
    assertIso(event.observed_at, `stall_history[${index}].observed_at`)
    if (event.last_protocol_activity_at) assertIso(event.last_protocol_activity_at, `stall_history[${index}].last_protocol_activity_at`)
    if (event.last_meaningful_progress_at) assertIso(event.last_meaningful_progress_at, `stall_history[${index}].last_meaningful_progress_at`)
    if (event.active_tools) {
      assert.ok(event.active_tools.length <= 1)
      event.active_tools.forEach((tool, toolIndex) => assertToolRecord(tool, `stall_history[${index}].active_tools[${toolIndex}]`))
    }
  }
  assert.ok(Array.isArray(value.active_tools) && value.active_tools.length <= 8)
  value.active_tools.forEach((tool, index) => assertToolRecord(tool, `active_tools[${index}]`))
  for (const [id, tool] of Object.entries(value.tools)) {
    assert.equal(id, tool.tool_call_id)
    assertToolRecord(tool, `tools[${id}]`)
  }
  assert.ok(value.tools && Object.keys(value.tools).length <= 64)
  for (const tool of value.active_tools) {
    assert.ok(value.tools[tool.tool_call_id], `active tool ${tool.tool_call_id} must have a matching tools record`)
  }
  if (TERMINAL_LIVENESS_STATES.has(value.liveness_state)) {
    assert.deepEqual(value.active_tools, [], 'terminal snapshots must not retain current active tools')
  }
  assert.ok(value.cancellation_unavailable === expectCancellationUnavailable)
  if (expectedState) assert.equal(value.liveness_state, expectedState)
  if (value.liveness_state === 'tool_running') {
    assert.ok(value.active_tools.length > 0, 'tool_running requires an active tool')
    assert.ok(value.active_tools.every((tool) => tool.status === 'in_progress'))
    assert.equal(value.cancellation_unavailable, false)
    assert.equal(value.stall_history.some((event) => event.state === 'cancellation_unavailable'), false)
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 64 * 1024, 'serialized snapshot must stay within 64 KiB')
}

function persistedArtifacts(cwd, taskId) {
  const livePath = join(cwd, '.tmux-teams', 'liveness', `${taskId}.json`)
  const dispatchPath = join(cwd, '.tmux-teams', 'dispatch', `${taskId}.md`)
  return [
    existsSync(livePath) ? readFileSync(livePath, 'utf8') : '',
    existsSync(dispatchPath) ? readFileSync(dispatchPath, 'utf8') : '',
    ...eventTexts(cwd),
  ]
}

async function waitForStage(stagePath, stage, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(stagePath) && readFileSync(stagePath, 'utf8').split(/\r?\n/).includes(stage)) return
    await sleep(10)
  }
  assert.fail(`timed out waiting for stage ${stage}`)
}

async function waitForFile(path, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${path}`)
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

// Issue #39: this used to read only /proc/<pid>/stat, which does not exist on
// darwin — every call here returned null on this platform, permanently, so
// assertPidGone's PID-reuse defence below was dead code and every failure it
// was built to explain instead surfaced as a plain reap timeout. `ps -o
// lstart=` is the darwin-and-friends equivalent: a per-process start-time
// string that is stable for the life of the process and changes the instant a
// reused pid belongs to a different one. A branch that genuinely cannot
// answer (pid already gone, `ps` unavailable) still returns null — the SAME
// contract the /proc branch already had — which the caller below treats as
// UNKNOWN, never as "definitely still the same process".
function processBirthId(pid) {
  if (!pid) return null
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${Number(pid)}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null
    } catch {
      return null
    }
  }
  try {
    const lstart = execFileSync('ps', ['-p', String(Number(pid)), '-o', 'lstart='], { encoding: 'utf8' }).trim()
    return lstart || null
  } catch {
    return null
  }
}

// Issue #39, second half: three independent outside reviews traced the report
// to this deadline. 1500ms is not a grace, it is a hard wall — the same shape
// the "ceiling, not a delay" comment further down this file already fixed
// twice (FORCED_TERM_KILL_GRACE_MS, CLEAN_EXIT_CANCEL_GRACE_MS) but never
// reached here. On a quiet machine the descendant is reaped well inside the
// configured ACP_PROCESS_KILL_GRACE_MS (20-300ms at every call site below),
// so this ceiling costs a clean run nothing and is never approached; under
// concurrent full-suite process-teardown pressure — the reported failure mode
// — the wait needs headroom the process-teardown queue can actually clear
// inside, not a number tuned to a quiet machine's own timing.
const PID_REAP_DEADLINE_MS = 5000

async function assertPidGone(pid, label, expectedBirthId = null) {
  if (!pid) return
  const deadline = Date.now() + PID_REAP_DEADLINE_MS
  while (Date.now() < deadline && pidAlive(pid)) {
    if (expectedBirthId && processBirthId(pid) !== expectedBirthId) return
    await sleep(20)
  }
  if (expectedBirthId && pidAlive(pid) && processBirthId(pid) !== expectedBirthId) return
  assert.equal(pidAlive(pid), false, `${label} pid ${pid} should be reaped`)
}

// Wait for the VALUE, not the path. `waitForFile` returned the moment
// `.descendant-pid` appeared, and the mock's `writeFileSync` opens with
// O_CREAT|O_TRUNC and writes second — so the poll could catch the file empty,
// `Number('')` gave 0, and `assert.ok(pid)` failed with `actual: 0`. That is
// issue #39, red once in six runs and called a load flake for a week; the
// message names a precondition, never the reap or the terminal state this test
// is actually about. The mock now renames into place, and this waits for a pid
// it can use, so neither half depends on the other having been fixed.
async function waitForDescendantPid(cwd, scenario, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = descendantPid(cwd)
    if (Number.isInteger(pid) && pid > 0) return pid
    await sleep(10)
  }
  assert.fail(`${scenario}: timed out waiting for a usable descendant pid in ${cwd}`)
}

function descendantPid(cwd) {
  const path = join(cwd, '.descendant-pid')
  return existsSync(path) ? Number(readFileSync(path, 'utf8').trim()) : null
}

for (const retiredName of ['gemini', 'Gemini', 'GEMINI', ' gemini ']) {
  test(`the retired agent name ${JSON.stringify(retiredName)} is rejected before custom override or dispatch`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-retired-'))
    const brief = join(cwd, 'brief.md')
    writeFileSync(brief, 'this must never be dispatched\n')
    const env = testEnv({ ACP_CMD: `node ${MOCK}` })
    const result = spawnSync('node', [
      COMPANION,
      retiredName,
      cwd,
      'task-retired-agent',
      brief,
      '30',
    ], { cwd, encoding: 'utf8', env })

    assert.equal(result.status, 2)
    assert.equal(existsSync(join(cwd, '.tmux-teams', 'dispatch')), false)
    assert.equal(eventTexts(cwd).length, 0)
  })
}

for (const [scenario, decision] of [
  ['prefer-always', 'allow-always'],
  ['prefer-once', 'allow-once'],
  ['fallback-first', 'reject-once'],
]) {
  concurrentTest(`session/request_permission ${scenario} selects ${decision} and lets the waiting agent continue`, async () => {
    const taskId = `task-permission-${scenario}`
    const r = await asyncRun(taskId, { MOCK_REQUEST_PERMISSION: scenario })
    assert.equal(r.status, 0, `exit 0 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
    assert.match(readFileSync(join(r.cwd, '.mailbox-out', taskId), 'utf8'),
      new RegExp(`^DID: mock work; permission=${decision}$`, 'm'))
  })
}

concurrentTest('session/request_permission with empty options returns cancelled and continues safely', async () => {
  const taskId = 'task-permission-empty'
  const r = await asyncRun(taskId, { MOCK_REQUEST_PERMISSION: 'empty' })
  assert.equal(r.status, 0, `exit 0 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(readFileSync(join(r.cwd, '.mailbox-out', taskId), 'utf8'),
    /^DID: mock work; permission=cancelled$/m)
})

concurrentTest('a persisted session id resumes a later same-id dispatch', async () => {
  const first = await asyncRun('task-persist')
  assert.equal(first.status, 0, `exit 0 expected; stderr:\n${first.stderr}`)
  const stored = join(first.cwd, '.tmux-teams', 'sessions', 'task-persist')
  assert.ok(existsSync(stored), 'session id file should be written')
  assert.equal(readFileSync(stored, 'utf8').trim(), 'sess_mock')
  const protocolLog = join(first.cwd, 'resume.protocol.log')
  const second = await asyncRun('task-persist', { MOCK_PROTOCOL_LOG: protocolLog }, first.cwd)
  assert.equal(second.status, 0, `exit 0 expected; stderr:\n${second.stderr}`)
  const protocol = readFileSync(protocolLog, 'utf8')
  assert.ok(protocol.includes('session/load:'), protocol)
  assert.equal(protocol.includes('session/new:'), false, protocol)
})

concurrentTest('ACP_RESUME falls back to a fresh session when loadSession is absent', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-no-load-'))
  const protocolLog = join(cwd, 'fallback.protocol.log')
  const r = await asyncRun('task-noload', {
    ACP_RESUME: 'sess_prev',
    MOCK_NO_LOAD: '1',
    MOCK_PROTOCOL_LOG: protocolLog,
  }, cwd)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const protocol = readFileSync(protocolLog, 'utf8')
  assert.equal(protocol.includes('session/load:'), false, protocol)
  assert.ok(protocol.includes('session/new:'), protocol)
})

concurrentTest('an unreadable persisted-session entry warns and starts fresh', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-'))
  mkdirSync(join(cwd, '.tmux-teams', 'sessions', 'task-bad-session'), { recursive: true })
  const r = await asyncRun('task-bad-session', {}, cwd)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const committed = receipt(cwd).value
  assert.equal(committed.requested_operation, 'new')
  assert.equal(committed.performed_operation, 'new')
  assert.equal(committed.effective_session_id, 'sess_mock')
})

concurrentTest('default mode writes a bounded new-session receipt before prompt delivery', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-default-'))
  const protocolLog = join(cwd, 'protocol.log')
  const r = await asyncRun('task-receipt-default', { MOCK_PROTOCOL_LOG: protocolLog, MOCK_ASSERT_RECEIPT_BEFORE_PROMPT: '1' }, cwd)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const committed = receipt(cwd)
  const dispatch = readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-default.md'), 'utf8')
  assert.equal(committed.value.schema_version, 'acp-session-receipt.v1')
  assert.equal(committed.value.requested_operation, 'new')
  assert.equal(committed.value.performed_operation, 'new')
  assert.equal(committed.value.operation_outcome, 'succeeded')
  assert.equal(committed.value.operation_witness, 'new_session_id_returned')
  assert.equal(committed.value.effective_session_id, 'sess_mock')
  assert.match(committed.value.operation_request_digest, /^sha256:[0-9a-f]{64}$/)
  assert.match(committed.value.operation_response_digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(committed.value.operation_rpc_id, 2)
  assert.equal(field(dispatch, 'receipt_digest'), digest(committed.raw))
  const dispatchId = field(dispatch, 'dispatch_id')
  const commitment = JSON.parse(readFileSync(join(cwd, '.tmux-teams', 'receipt-commits', `${dispatchId}.json`), 'utf8'))
  assert.deepEqual(Object.keys(commitment).sort(), ['committed_state', 'dispatch_id', 'receipt_digest', 'schema', 'schema_version'].sort())
  assert.equal(commitment.schema, 'acp-session-receipt-commit')
  assert.equal(commitment.schema_version, 'acp-session-receipt-commit.v1')
  assert.equal(commitment.dispatch_id, dispatchId)
  assert.equal(commitment.receipt_digest, digest(committed.raw))
  assert.equal(readFileSync(join(cwd, '.prompt-receipt-seen'), 'utf8').trim(), 'true')
  assert.match(eventTexts(cwd)[0], new RegExp(`^receipt_digest: ${digest(committed.raw)}$`, 'm'))
  assert.deepEqual(readFileSync(protocolLog, 'utf8').trim().split('\n').map((line) => line.split(':')[0]), ['initialize', 'session/new', 'session/prompt'])
  assert.ok(!committed.raw.includes(cwd))
  assert.doesNotMatch(committed.raw, /(?:\/home|\/tmp)\//)
  assert.ok(!committed.raw.includes('do the thing'))
  assert.ok(Buffer.byteLength(committed.raw, 'utf8') <= 32 * 1024)
})

concurrentTest('per-dispatch ACP model and reasoning overrides are applied before identity and prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-config-override-'))
  const protocolLog = join(cwd, 'config-override.protocol.log')
  const r = await asyncRun('task-config-override', {
    ACP_MODEL: 'gpt-target',
    ACP_REASONING_EFFORT: 'high',
    MOCK_CONFIG_IDENTITY: '1',
    MOCK_MODEL: 'gpt-default',
    MOCK_REASONING_EFFORT: 'low',
    MOCK_MODEL_OPTIONS: 'gpt-default,gpt-target',
    MOCK_REASONING_EFFORT_OPTIONS: 'low,high',
    MOCK_PROTOCOL_LOG: protocolLog,
  }, cwd)
  assert.equal(r.status, 0, `override exit 0 expected; stderr:\n${r.stderr}`)
  const committed = receipt(cwd).value
  assert.equal(committed.requested_model, 'gpt-target')
  assert.equal(committed.requested_reasoning_effort, 'high')
  assert.equal(committed.effective_identity, 'gpt-target[high]')
  assert.equal(committed.identity_status, 'matched')
  assert.deepEqual(
    readFileSync(protocolLog, 'utf8').trim().split('\n').map((line) => line.split(':')[0]),
    ['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt'],
  )
})

concurrentTest('label-suffixed model option values (antigravity-acp shape) still pin the bare id', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-tabbed-model-'))
  const protocolLog = join(cwd, 'tabbed-model.protocol.log')
  const r = await asyncRun('task-tabbed-model', {
    ACP_MODEL: 'gemini-x',
    MOCK_CONFIG_IDENTITY: '1',
    MOCK_MODEL: 'gemini-default',
    MOCK_MODEL_OPTIONS: 'gemini-x\tGemini X (High),gemini-default\tGemini Default',
    MOCK_MODEL_OPTIONS_STRICT: '1',
    MOCK_PROTOCOL_LOG: protocolLog,
  }, cwd)
  assert.equal(r.status, 0, `tabbed model value exit 0 expected; stderr:\n${r.stderr}`)
  assert.equal(receipt(cwd).value.requested_model, 'gemini-x')
  assert.deepEqual(
    readFileSync(protocolLog, 'utf8').trim().split('\n').map((line) => line.split(':')[0]),
    ['initialize', 'session/new', 'session/set_config_option', 'session/prompt'],
  )
})

concurrentTest('a model absent from even the label-suffixed list is still refused', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-tabbed-missing-'))
  const r = await asyncRun('task-tabbed-missing', {
    ACP_MODEL: 'gemini-other',
    MOCK_CONFIG_IDENTITY: '1',
    MOCK_MODEL: 'gemini-default',
    MOCK_MODEL_OPTIONS: 'gemini-x\tGemini X (High)',
    MOCK_MODEL_OPTIONS_STRICT: '1',
  }, cwd)
  assert.notEqual(r.status, 0, 'unsupported model must still fail the pre-check')
  assert.match(r.stderr, /rejected unsupported model value gemini-other/)
})

concurrentTest('per-dispatch ACP overrides also apply to a loaded session', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-config-load-'))
  const first = await asyncRun('task-config-load', {
    MOCK_CONFIG_IDENTITY: '1',
    MOCK_MODEL: 'gpt-default',
    MOCK_REASONING_EFFORT: 'low',
    MOCK_MODEL_OPTIONS: 'gpt-default,gpt-target',
    MOCK_REASONING_EFFORT_OPTIONS: 'low,high',
  }, cwd)
  assert.equal(first.status, 0, `baseline exit 0 expected; stderr:\n${first.stderr}`)
  const protocolLog = join(cwd, 'config-load.protocol.log')
  const loaded = await asyncRun('task-config-load', {
    ACP_RESUME: 'sess_mock',
    ACP_MODEL: 'gpt-target',
    ACP_REASONING_EFFORT: 'high',
    MOCK_CONFIG_IDENTITY: '1',
    MOCK_MODEL: 'gpt-default',
    MOCK_REASONING_EFFORT: 'low',
    MOCK_MODEL_OPTIONS: 'gpt-default,gpt-target',
    MOCK_REASONING_EFFORT_OPTIONS: 'low,high',
    MOCK_PROTOCOL_LOG: protocolLog,
  }, cwd)
  assert.equal(loaded.status, 0, `loaded override exit 0 expected; stderr:\n${loaded.stderr}`)
  const state = snapshot(loaded.cwd, 'task-config-load')
  assert.equal(state.session_id, 'sess_mock')
  assert.equal(state.requested_model, 'gpt-target')
  assert.equal(state.requested_reasoning_effort, 'high')
  assert.equal(state.effective_identity, 'gpt-target[high]')
  assert.equal(state.identity_status, 'matched')
  assert.deepEqual(
    readFileSync(protocolLog, 'utf8').trim().split('\n').map((line) => line.split(':')[0]),
    ['initialize', 'session/load', 'session/set_config_option', 'session/set_config_option', 'session/prompt'],
  )
})

concurrentTest('an unavailable per-dispatch ACP model fails closed before config mutation or prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-config-invalid-'))
  const protocolLog = join(cwd, 'config-invalid.protocol.log')
  const r = await asyncRun('task-config-invalid', {
    ACP_MODEL: 'gpt-missing',
    MOCK_CONFIG_IDENTITY: '1',
    MOCK_MODEL: 'gpt-default',
    MOCK_REASONING_EFFORT: 'low',
    MOCK_MODEL_OPTIONS: 'gpt-default,gpt-target',
    MOCK_REASONING_EFFORT_OPTIONS: 'low,high',
    MOCK_PROTOCOL_LOG: protocolLog,
  }, cwd)
  assert.equal(r.status, 1, `invalid override must fail; stderr:\n${r.stderr}`)
  const protocol = readFileSync(protocolLog, 'utf8')
  assert.match(protocol, /session\/new/)
  assert.doesNotMatch(protocol, /session\/set_config_option|session\/prompt/)
  assert.equal(receipt(cwd).value.identity_status, 'missing')
})

concurrentTest('required mode records an exact load witness and ignores a response sessionId', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-load-'))
  const profile = writeExecutionProfile(cwd)
  const first = await asyncRun('task-receipt-lineage', {
    ACP_SESSION_RECEIPT_REQUIRED: '1',
    ACP_SESSION_OPERATION: 'new',
    ACP_EXECUTION_PROFILE: profile,
  }, cwd)
  assert.equal(first.status, 0, `new exit 0 expected; stderr:\n${first.stderr}`)
  const firstDispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-lineage.md'), 'utf8'), 'dispatch_id')
  const firstReceipt = receiptFor(cwd, firstDispatch)
  const second = await asyncRun('task-receipt-lineage', {
    ACP_SESSION_RECEIPT_REQUIRED: '1',
    ACP_SESSION_OPERATION: 'load',
    ACP_RESUME: firstReceipt.value.effective_session_id,
    ACP_PRIOR_DISPATCH_ID: firstDispatch,
    ACP_PRIOR_RECEIPT_DIGEST: digest(firstReceipt.raw),
    ACP_EXECUTION_PROFILE: profile,
    MOCK_LOAD_RESPONSE_SESSION_ID: 'spoofed-response-id',
    MOCK_PROTOCOL_LOG: join(cwd, 'protocol.log'),
  }, cwd)
  assert.equal(second.status, 0, `load exit 0 expected; stderr:\n${second.stderr}`)
  const secondDispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-lineage.md'), 'utf8'), 'dispatch_id')
  assert.notEqual(secondDispatch, firstDispatch)
  const secondReceipt = receiptFor(cwd, secondDispatch)
  assert.equal(secondReceipt.value.requested_operation, 'load')
  assert.equal(secondReceipt.value.performed_operation, 'load')
  assert.equal(secondReceipt.value.operation_outcome, 'succeeded')
  assert.equal(secondReceipt.value.operation_witness, 'load_response_for_exact_request')
  assert.equal(secondReceipt.value.resume_status, 'loaded')
  assert.equal(secondReceipt.value.requested_resume_session_id, firstReceipt.value.effective_session_id)
  assert.equal(secondReceipt.value.effective_session_id, firstReceipt.value.effective_session_id)
  assert.equal(secondReceipt.value.prior_dispatch_id, firstDispatch)
  assert.equal(secondReceipt.value.prior_receipt_digest, digest(firstReceipt.raw))
  assert.match(secondReceipt.value.operation_request_digest, /^sha256:[0-9a-f]{64}$/)
  assert.match(secondReceipt.value.operation_response_digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(snapshot(cwd, 'task-receipt-lineage').session_id, firstReceipt.value.effective_session_id)
  assert.equal(readdirSync(join(cwd, '.tmux-teams', 'receipts')).length, 2)
})

concurrentTest('required load fallback is explicit and cannot claim a loaded session', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-fallback-'))
  const profile = writeExecutionProfile(cwd)
  const first = await asyncRun('task-receipt-fallback', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
  }, cwd)
  assert.equal(first.status, 0, `new exit 0 expected; stderr:\n${first.stderr}`)
  const firstDispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-fallback.md'), 'utf8'), 'dispatch_id')
  const firstReceipt = receiptFor(cwd, firstDispatch)
  const retry = await asyncRun('task-receipt-fallback', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'load', ACP_RESUME: firstReceipt.value.effective_session_id,
    ACP_PRIOR_DISPATCH_ID: firstDispatch, ACP_PRIOR_RECEIPT_DIGEST: digest(firstReceipt.raw),
    ACP_EXECUTION_PROFILE: profile, MOCK_NO_LOAD: '1',
  }, cwd)
  assert.equal(retry.status, 0, `fallback exit 0 expected; stderr:\n${retry.stderr}`)
  const dispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-fallback.md'), 'utf8'), 'dispatch_id')
  const value = receiptFor(cwd, dispatch).value
  assert.equal(value.requested_operation, 'load')
  assert.equal(value.performed_operation, 'new')
  assert.equal(value.operation_outcome, 'unsupported_fallback')
  assert.equal(value.resume_status, 'unsupported_fallback')
  assert.notEqual(value.operation_witness, 'load_response_for_exact_request')
})

concurrentTest('required load failure writes a null-operation tombstone and never sends prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-failure-'))
  const profile = writeExecutionProfile(cwd)
  const first = await asyncRun('task-receipt-failure', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
  }, cwd)
  assert.equal(first.status, 0, `new exit 0 expected; stderr:\n${first.stderr}`)
  const firstDispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-failure.md'), 'utf8'), 'dispatch_id')
  const firstReceipt = receiptFor(cwd, firstDispatch)
  const log = join(cwd, 'load-failure.protocol.log')
  const retry = await asyncRun('task-receipt-failure', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'load', ACP_RESUME: firstReceipt.value.effective_session_id,
    ACP_PRIOR_DISPATCH_ID: firstDispatch, ACP_PRIOR_RECEIPT_DIGEST: digest(firstReceipt.raw), ACP_EXECUTION_PROFILE: profile,
    MOCK_LOAD_ERROR: '1', MOCK_PROTOCOL_LOG: log,
  }, cwd)
  assert.notEqual(retry.status, 0, `load failure must be nonzero; stderr:\n${retry.stderr}`)
  const dispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-failure.md'), 'utf8'), 'dispatch_id')
  const value = receiptFor(cwd, dispatch).value
  assert.equal(value.requested_operation, 'load')
  assert.equal(value.performed_operation, null)
  assert.equal(value.effective_session_id, null)
  assert.equal(value.operation_outcome, 'failed')
  assert.equal(value.resume_status, 'load_failed')
  assert.ok(!readFileSync(log, 'utf8').includes('session/prompt'))
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'sessions', 'task-receipt-failure')), true)
})

test('required load binds every prior identity and execution-profile field before spawn', async () => {
  const mutations = [
    ['task_id', (value) => ({ ...value, task_id: 'other-task' })],
    ['worker', (value) => ({ ...value, worker: 'other-worker' })],
    ['transport', (value) => ({ ...value, transport: 'other' })],
    ['agent_id', (value) => ({ ...value, agent_id: 'other-agent' })],
    ['requested_model', (value) => ({ ...value, requested_model: 'other-model' })],
    ['requested_reasoning_effort', (value) => ({ ...value, requested_reasoning_effort: 'other-effort' })],
    ['effective_identity', (value) => ({ ...value, effective_identity: 'other-model[ultra]' })],
    ['identity_status', (value) => ({ ...value, identity_status: 'unverified' })],
    ['initialize_agent_info', (value) => ({ ...value, initialize_agent_info: { name: 'other-adapter', version: '1' } })],
    ['adapter_package_spec', (value) => ({ ...value, adapter_package_spec: 'other-acp@1.0.0' })],
    ['adapter_resolved_version', (value) => ({ ...value, adapter_resolved_version: '9.9.9' })],
    ['adapter_integrity', (value) => ({ ...value, adapter_integrity: `sha512-${'A'.repeat(88)}` })],
    ['adapter_metadata_digest', (value) => ({ ...value, adapter_metadata_digest: `sha256:${'1'.repeat(64)}` })],
    ['adapter_entry_digest', (value) => ({ ...value, adapter_entry_digest: `sha256:${'2'.repeat(64)}` })],
    ['codex_executable_identity', (value) => ({ ...value, codex_executable_identity: { ...value.codex_executable_identity, executable_digest: `sha256:${'3'.repeat(64)}` } })],
    ['node_executable_identity', (value) => ({ ...value, node_executable_identity: { ...value.node_executable_identity, executable_digest: `sha256:${'4'.repeat(64)}` } })],
    ['execution_profile_digest', (value) => ({ ...value, execution_profile_digest: `sha256:${'5'.repeat(64)}` })],
    ['initial_agent_mode', (value) => ({ ...value, initial_agent_mode: 'read-only' })],
    ['effective_session_id', (value) => ({ ...value, effective_session_id: 'different_session' })],
  ]
  await forEachConcurrent(mutations, 4, async ([fieldName, mutate]) => {
    const cwd = mkdtempSync(join(tmpdir(), `acp-companion-lineage-${fieldName}-`))
    const taskId = `task-lineage-${fieldName.replaceAll('_', '-')}`
    const profile = writeExecutionProfile(cwd)
    const first = await asyncRun(taskId, {
      ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
      ACP_AGENT_ID: 'stable-agent', ACP_EXPECT_MODEL: 'gpt-test', ACP_EXPECT_REASONING_EFFORT: 'ultra',
      MOCK_MODEL: 'gpt-test', MOCK_REASONING_EFFORT: 'ultra',
    }, cwd, 30, 'mock')
    assert.equal(first.status, 0, `${fieldName}: first dispatch failed: ${first.stderr}`)
    const firstDispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', `${taskId}.md`), 'utf8'), 'dispatch_id')
    const mutated = rewritePriorReceiptPair(cwd, firstDispatch, mutate)
    rmSync(join(cwd, '.initial-agent-mode'), { force: true })
    const retry = await asyncRun(taskId, {
      ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'load',
      ACP_RESUME: 'sess_mock', ACP_PRIOR_DISPATCH_ID: firstDispatch, ACP_PRIOR_RECEIPT_DIGEST: digest(mutated.raw),
      ACP_EXECUTION_PROFILE: profile, ACP_AGENT_ID: 'stable-agent', ACP_EXPECT_MODEL: 'gpt-test', ACP_EXPECT_REASONING_EFFORT: 'ultra',
      MOCK_MODEL: 'gpt-test', MOCK_REASONING_EFFORT: 'ultra',
    }, cwd, 30, 'mock')
    assert.equal(retry.status, 2, `${fieldName}: mutated prior lineage must fail before spawn: ${retry.stderr}`)
    assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false, `${fieldName}: adapter must not spawn after prior validation failure`)
  })
})

concurrentTest('required load correlation failure writes a null-operation tombstone and never sends prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-correlation-'))
  const profile = writeExecutionProfile(cwd)
  const first = await asyncRun('task-receipt-correlation', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
  }, cwd)
  assert.equal(first.status, 0, `new exit 0 expected; stderr:\n${first.stderr}`)
  const firstDispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-correlation.md'), 'utf8'), 'dispatch_id')
  const firstReceipt = receiptFor(cwd, firstDispatch)
  const log = join(cwd, 'load-correlation.protocol.log')
  const retry = await asyncRun('task-receipt-correlation', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'load', ACP_RESUME: firstReceipt.value.effective_session_id,
    ACP_PRIOR_DISPATCH_ID: firstDispatch, ACP_PRIOR_RECEIPT_DIGEST: digest(firstReceipt.raw), ACP_EXECUTION_PROFILE: profile,
    ACP_TEST_RECEIPT_CORRELATION_FAILURE: '1', MOCK_PROTOCOL_LOG: log,
  }, cwd)
  assert.notEqual(retry.status, 0, `correlation failure must be nonzero; stderr:\n${retry.stderr}`)
  const dispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-correlation.md'), 'utf8'), 'dispatch_id')
  const value = receiptFor(cwd, dispatch).value
  assert.equal(value.requested_operation, 'load')
  assert.equal(value.performed_operation, null)
  assert.equal(value.effective_session_id, null)
  assert.equal(value.operation_outcome, 'failed')
  assert.equal(value.resume_status, 'load_failed')
  assert.equal(readFileSync(log, 'utf8').includes('session/prompt'), false)
})

concurrentTest('identity mismatch publishes a failed immutable receipt before prompt delivery', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-identity-mismatch-'))
  const protocolLog = join(cwd, 'identity-mismatch.protocol.log')
  const r = await asyncRun('task-receipt-identity-mismatch', {
    ACP_EXPECT_MODEL: 'gpt-5.6-luna',
    ACP_EXPECT_REASONING_EFFORT: 'ultra',
    MOCK_MODEL: 'unexpected-model',
    MOCK_PROTOCOL_LOG: protocolLog,
  }, cwd)
  assert.equal(r.status, 1, `identity mismatch must fail; stderr:\n${r.stderr}`)
  const committed = receipt(cwd)
  assert.equal(committed.value.operation_outcome, 'failed')
  assert.equal(committed.value.performed_operation, null)
  assert.equal(committed.value.effective_session_id, null)
  assert.equal(committed.value.operation_witness, 'none')
  assert.equal(committed.value.identity_status, 'mismatched')
  assert.equal(committed.value.operation_acknowledged_at !== null, true)
  assert.match(committed.value.operation_response_digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(readFileSync(protocolLog, 'utf8').includes('session/prompt'), false)
})

for (const [scenario, expectedStatus, expectedInfo] of [
  ['missing', 'missing', null],
  ['mismatch', 'mismatched', { name: 'unexpected-adapter', version: '9' }],
]) {
  concurrentTest(`observed initialize agent identity ${scenario} fails before session operation`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `acp-companion-initialize-identity-${scenario}-`))
    const profile = writeExecutionProfile(cwd)
    const protocolLog = join(cwd, 'initialize-identity.protocol.log')
    const r = await asyncRun(`task-initialize-identity-${scenario}`, {
      ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
      MOCK_PROTOCOL_LOG: protocolLog,
      ...(scenario === 'missing' ? { MOCK_NO_AGENT_INFO: '1' } : { MOCK_AGENT_NAME: 'unexpected-adapter', MOCK_AGENT_VERSION: '9' }),
    }, cwd, 30, 'mock')
    assert.notEqual(r.status, 0, `identity ${scenario} must fail: ${r.stderr}`)
    const value = receipt(cwd).value
    assert.equal(value.operation_outcome, 'failed')
    assert.equal(value.identity_status, expectedStatus)
    assert.deepEqual(value.initialize_agent_info, expectedInfo)
    const protocol = readFileSync(protocolLog, 'utf8')
    assert.doesNotMatch(protocol, /session\/new|session\/load|session\/prompt/)
  })
}

concurrentTest('required mode rejects an arbitrary ACP_CMD before adapter spawn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-cmd-'))
  const r = await asyncRun('task-required-command', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_CMD: `node ${MOCK}`,
  }, cwd)
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
  const committed = receipt(cwd)
  assert.equal(committed.value.operation_outcome, 'failed')
  assert.equal(committed.value.performed_operation, null)
  assert.equal(committed.value.effective_session_id, null)
  assert.equal(committed.value.operation_witness, 'none')
})

concurrentTest('required Codex mode rejects a drifted pinned adapter cache before spawn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-adapter-drift-'))
  const cache = join(cwd, 'npm-cache')
  const packageRoot = join(cache, '_npx', 'fake-cache-entry', 'node_modules', '@agentclientprotocol', 'codex-acp')
  const binRoot = join(packageRoot, 'bin')
  mkdirSync(binRoot, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@agentclientprotocol/codex-acp',
    version: '1.1.7',
    bin: { 'codex-acp': 'bin/codex-acp' },
  }), { mode: 0o600 })
  writeExecutable(join(binRoot, 'codex-acp'), '#!/bin/sh\nexit 0\n')
  const r = await asyncRun('task-required-adapter-drift', {
    ACP_CMD: null,
    ACP_SESSION_RECEIPT_REQUIRED: '1',
    ACP_SESSION_OPERATION: 'new',
    NPM_CONFIG_CACHE: cache,
  }, cwd, 30, 'codex')
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
  const committed = receipt(cwd)
  assert.equal(committed.value.operation_outcome, 'failed')
  assert.equal(committed.value.performed_operation, null)
  assert.equal(committed.value.effective_session_id, null)
})

for (const targetKind of ['symlink', 'non-directory']) {
  concurrentTest(`required receipt publication rejects a ${targetKind} receipt directory before prompt`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `acp-companion-receipt-${targetKind}-target-`))
    const tmuxDir = join(cwd, '.tmux-teams')
    const receiptsDir = join(tmuxDir, 'receipts')
    mkdirSync(tmuxDir, { recursive: true })
    if (targetKind === 'symlink') {
      const outside = join(cwd, 'outside-receipts')
      mkdirSync(outside)
      symlinkSync(outside, receiptsDir, 'dir')
    } else {
      writeFileSync(receiptsDir, 'not a directory\n', { mode: 0o600 })
    }
    const profile = writeExecutionProfile(cwd)
    const protocolLog = join(cwd, `${targetKind}.protocol.log`)
    const r = await asyncRun('task-receipt-directory-target', {
      ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
      MOCK_PROTOCOL_LOG: protocolLog,
    }, cwd)
    assert.notEqual(r.status, 0, `${targetKind} receipt directory must fail closed; stderr:\n${r.stderr}`)
    assert.equal(readFileSync(protocolLog, 'utf8').includes('session/prompt'), false)
    if (targetKind === 'symlink') assert.deepEqual(readdirSync(join(cwd, 'outside-receipts')), [])
  })
}

for (const targetKind of ['symlink', 'directory']) {
  concurrentTest(`required load rejects a ${targetKind} commitment target without spawning`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `acp-companion-receipt-commit-${targetKind}-`))
    const profile = writeExecutionProfile(cwd)
    const first = await asyncRun('task-receipt-commit-target', {
      ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
    }, cwd)
    assert.equal(first.status, 0, `seed receipt failed: ${first.stderr}`)
    const dispatchId = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-commit-target.md'), 'utf8'), 'dispatch_id')
    const firstReceipt = receiptFor(cwd, dispatchId)
    const commitmentPath = join(cwd, '.tmux-teams', 'receipt-commits', `${dispatchId}.json`)
    const commitmentRaw = readFileSync(commitmentPath)
    rmSync(commitmentPath, { force: true })
    if (targetKind === 'directory') mkdirSync(commitmentPath)
    else {
      const outside = join(cwd, 'outside-commit.json')
      writeFileSync(outside, commitmentRaw, { mode: 0o600 })
      symlinkSync(outside, commitmentPath, 'file')
    }
    rmSync(join(cwd, '.initial-agent-mode'), { force: true })
    const retry = await asyncRun('task-receipt-commit-target', {
      ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'load', ACP_RESUME: firstReceipt.value.effective_session_id,
      ACP_PRIOR_DISPATCH_ID: dispatchId, ACP_PRIOR_RECEIPT_DIGEST: digest(firstReceipt.raw), ACP_EXECUTION_PROFILE: profile,
    }, cwd)
    assert.equal(retry.status, 2, `${targetKind} commitment target must fail closed: ${retry.stderr}`)
    assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
  })
}

concurrentTest('required mode does not infer operation or resume lineage from mutable session state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-intent-'))
  mkdirSync(join(cwd, '.tmux-teams', 'sessions'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'sessions', 'task-required-intent'), 'sess_prev\n', { mode: 0o600 })
  const r = await asyncRun('task-required-intent', { ACP_SESSION_RECEIPT_REQUIRED: '1' }, cwd)
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
})

concurrentTest('required execution profile drift fails before ACP operation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-profile-'))
  const profile = writeExecutionProfile(cwd)
  const value = JSON.parse(readFileSync(profile, 'utf8'))
  value.adapter.entry_digest = digest('drifted-entry')
  writeFileSync(profile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  const r = await asyncRun('task-required-profile-drift', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
  }, cwd)
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
})

concurrentTest('execution profiles attest exact raw adapter bytes, including NUL and invalid UTF-8', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-binary-profile-'))
  const binary = writeBinaryAdapterProfile(cwd)
  const sha256sum = spawnSync('sha256sum', [binary.adapterPath], { encoding: 'utf8' })
  assert.equal(sha256sum.status, 0)
  const externalDigest = `sha256:${sha256sum.stdout.trim().split(/\s+/)[0]}`
  assert.equal(digest(binary.bytes), externalDigest)
  assert.notEqual(digest(String(binary.bytes)), externalDigest, 'replacement-text hashing must differ from raw-byte hashing')
  assert.ok(binary.bytes.includes(0x00))
  assert.ok(binary.bytes.includes(0xff))

  const good = await asyncRun('task-binary-profile', {
    ACP_SESSION_RECEIPT_REQUIRED: '1',
    ACP_SESSION_OPERATION: 'new',
    ACP_CMD: `${NODE_EXECUTABLE} ${binary.adapterPath}`,
    ACP_EXECUTION_PROFILE: binary.profilePath,
  }, cwd, 30, 'mock')
  assert.equal(good.status, 0, `raw-byte profile should spawn; stderr:\n${good.stderr}`)
  assert.equal(receipt(cwd).value.adapter_entry_digest, externalDigest)

  const badCwd = mkdtempSync(join(tmpdir(), 'acp-companion-binary-profile-drift-'))
  const divergent = writeBinaryAdapterProfile(badCwd, { divergent: true })
  const divergentValue = JSON.parse(readFileSync(divergent.profilePath, 'utf8'))
  divergentValue.adapter.entry_digest = binary.profile.adapter.entry_digest
  divergentValue.adapter.integrity = binary.profile.adapter.integrity
  divergentValue.profile_digest = digest(JSON.stringify(stableValue(divergentValue)))
  writeFileSync(divergent.profilePath, `${JSON.stringify(divergentValue, null, 2)}\n`, { mode: 0o600 })
  const bad = await asyncRun('task-binary-profile-drift', {
    ACP_SESSION_RECEIPT_REQUIRED: '1',
    ACP_SESSION_OPERATION: 'new',
    ACP_CMD: `${NODE_EXECUTABLE} ${divergent.adapterPath}`,
    ACP_EXECUTION_PROFILE: divergent.profilePath,
  }, badCwd, 30, 'mock')
  assert.equal(bad.status, 2)
  assert.equal(existsSync(join(badCwd, '.initial-agent-mode')), false)
})

concurrentTest('required Codex mode rejects an absolute fake CODEX_PATH before adapter spawn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-codex-path-'))
  const fake = writeExecutable(join(cwd, 'fake-codex'), '#!/bin/sh\nprintf "codex-cli 0.144.6\\n"\n')
  const r = await asyncRun('task-required-fake-codex-path', {
    ACP_CMD: null,
    ACP_SESSION_RECEIPT_REQUIRED: '1',
    ACP_SESSION_OPERATION: 'new',
    CODEX_PATH: fake,
  }, cwd, 30, 'codex')
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
})

concurrentTest('required Codex mode rejects a fake PATH shadow even when CODEX_PATH names the real executable', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-path-shadow-'))
  const bin = join(cwd, 'bin')
  mkdirSync(bin)
  writeExecutable(join(bin, 'codex'), '#!/bin/sh\nprintf "codex-cli 0.144.6\\n"\n')
  const r = await asyncRun('task-required-path-shadow', {
    ACP_CMD: null,
    ACP_SESSION_RECEIPT_REQUIRED: '1',
    ACP_SESSION_OPERATION: 'new',
    CODEX_PATH: CODEX_EXECUTABLE,
    PATH: `${bin}:${process.env.PATH}`,
  }, cwd, 30, 'codex')
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
})

concurrentTest('required profile rejects a fake self-reported Codex version before spawn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-fake-version-'))
  const profile = writeExecutionProfile(cwd)
  const value = JSON.parse(readFileSync(profile, 'utf8'))
  value.codex.version = 'codex-cli 0.0.0-fake'
  value.profile_digest = digest(JSON.stringify(stableValue({ ...value, profile_digest: undefined })))
  delete value.profile_digest
  value.profile_digest = digest(JSON.stringify(stableValue(value)))
  writeFileSync(profile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  const r = await asyncRun('task-required-fake-version', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
  }, cwd, 30, 'codex')
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
})

concurrentTest('required mode rejects unsafe session ids before receipt success or prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-session-id-'))
  const profile = writeExecutionProfile(cwd)
  const r = await asyncRun('task-required-session-id', {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
    MOCK_SESSION_ID: 'unsafe/session/id', MOCK_PROTOCOL_LOG: join(cwd, 'protocol.log'),
  }, cwd)
  assert.notEqual(r.status, 0)
  assert.equal(readFileSync(join(cwd, 'protocol.log'), 'utf8').includes('session/prompt'), false)
  const state = snapshot(cwd, 'task-required-session-id')
  assert.equal(state.liveness_state, 'failed')
})

const RECEIPT_FAILURE_CASES = ['serialize', 'schema', 'write', 'file-fsync', 'publish', 'directory-fsync', 'readback']
  .flatMap((failureStage) => [1, 2, 3].map((repeat) => ({ failureStage, repeat })))

test('required receipt persistence failures block prompt and persist terminal failure evidence', { concurrency: 4 }, async (t) => {
  const settled = await Promise.allSettled(RECEIPT_FAILURE_CASES.map(({ failureStage, repeat }) => (
    t.test(`required receipt ${failureStage} failure repeat ${repeat} blocks prompt and persists terminal failure evidence`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `acp-companion-receipt-${failureStage}-`))
    const profile = writeExecutionProfile(cwd)
    const envKey = failureStage === 'serialize' ? 'ACP_TEST_RECEIPT_SERIALIZE_FAILURE'
        : failureStage === 'schema' ? 'ACP_TEST_RECEIPT_SCHEMA_FAILURE'
          : failureStage === 'write' ? 'ACP_TEST_RECEIPT_WRITE_FAILURE'
            : failureStage === 'file-fsync' ? 'ACP_TEST_RECEIPT_FILE_FSYNC_FAILURE'
              : failureStage === 'publish' ? 'ACP_TEST_RECEIPT_PUBLISH_FAILURE'
                : failureStage === 'directory-fsync' ? 'ACP_TEST_RECEIPT_DIRECTORY_FSYNC_FAILURE'
                  : 'ACP_TEST_RECEIPT_READBACK_FAILURE'
    const log = join(cwd, 'protocol.log')
    const r = await asyncRun('task-receipt-persist-failure', {
      ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
      [envKey]: '1', MOCK_PROTOCOL_LOG: log,
    }, cwd)
    assert.notEqual(r.status, 0, `receipt ${failureStage} must fail closed; stderr:\n${r.stderr}`)
    assert.equal(readFileSync(log, 'utf8').includes('session/prompt'), false)
    const state = snapshot(cwd, 'task-receipt-persist-failure')
    assert.equal(state.liveness_state, 'failed')
    assert.equal(state.termination_reason, 'receipt_persistence_failed')
    const dispatch = readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-persist-failure.md'), 'utf8')
    assert.match(dispatch, /^liveness_persistence_failed: false$/m)
    assert.match(dispatch, /^receipt_persistence_failed: true$/m)
    assert.match(dispatch, /^liveness_state: failed$/m)
    const committed = receipt(cwd)
    if (failureStage === 'directory-fsync' || failureStage === 'readback') {
      assert.equal(committed.value.operation_outcome, 'succeeded', 'a visible receipt is not trusted without its verified commitment/readback')
      const failuresDir = join(cwd, '.tmux-teams', 'receipt-failures')
      assert.equal(readdirSync(failuresDir).length, 1)
    } else {
      assert.equal(committed.value.operation_outcome, 'failed')
      assert.equal(committed.value.performed_operation, null)
      assert.equal(committed.value.effective_session_id, null)
    }
    assert.deepEqual(readdirSync(join(cwd, '.tmux-teams', 'receipts')).filter((name) => name.endsWith('.tmp')), [])
    })
  )))
  const failure = settled.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
})

concurrentTest('receipt schema is closed and all committed receipt strings remain bounded UTF-8 metadata', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-schema-'))
  const r = await asyncRun('task-receipt-schema', { ACP_AGENT_ID: 'receipt-agent' }, cwd)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const committed = receipt(cwd)
  const expected = new Set([
    'schema', 'schema_version', 'task_id', 'dispatch_id', 'agent_id', 'worker', 'transport',
    'requested_operation', 'performed_operation', 'operation_outcome', 'requested_resume_session_id',
    'effective_session_id', 'prior_dispatch_id', 'prior_receipt_digest', 'operation_witness',
    'operation_request_digest', 'operation_response_digest', 'operation_rpc_id', 'operation_acknowledged_at',
    'requested_model', 'requested_reasoning_effort', 'effective_identity', 'identity_status',
    'adapter_package_spec', 'adapter_resolved_version', 'adapter_integrity', 'adapter_metadata_digest',
    'adapter_entry_digest', 'initialize_agent_info', 'execution_profile_digest', 'initial_agent_mode',
    'codex_executable_identity', 'node_executable_identity', 'resume_status',
  ])
  assert.deepEqual(new Set(Object.keys(committed.value)), expected)
  assert.equal(committed.value.agent_id, 'receipt-agent')
  assert.ok(Buffer.byteLength(committed.raw, 'utf8') <= 32 * 1024)
  assert.ok(!committed.raw.includes(cwd))
  assert.ok(!committed.raw.includes('do the thing'))
  // No entry path means no entry bytes were hashed, so there is nothing this
  // field may claim. It used to carry the hash of the argv TEXT and this line
  // asserted the shape of that hash — pinning a receipt that read as though the
  // executed file had been verified when only the words had.
  assert.equal(committed.value.adapter_entry_digest, null)
  assert.match(committed.value.execution_profile_digest, /^sha256:[0-9a-f]{64}$/)
})

concurrentTest('schema-only receipt matrix covers 20 valid and 60 invalid named controls', async () => {
  const schema = fixture(RECEIPT_SCHEMA_FILE)
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-schema-matrix-'))
  const r = await asyncRun('task-receipt-schema-matrix', {}, cwd)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const base = receipt(cwd).value
  const priorDigest = `sha256:${'0'.repeat(64)}`
  const loadSuccess = {
    ...base,
    requested_operation: 'load', performed_operation: 'load',
    requested_resume_session_id: 'sess_prev', effective_session_id: 'sess_prev',
    prior_dispatch_id: 'prior_dispatch', prior_receipt_digest: priorDigest,
    operation_witness: 'load_response_for_exact_request', resume_status: 'loaded',
  }
  const fallback = {
    ...base,
    requested_operation: 'load', performed_operation: 'new',
    operation_outcome: 'unsupported_fallback',
    requested_resume_session_id: 'sess_prev', effective_session_id: 'sess_new',
    prior_dispatch_id: 'prior_dispatch', prior_receipt_digest: priorDigest,
    operation_witness: 'new_session_id_returned', resume_status: 'unsupported_fallback',
  }
  const failedNew = {
    ...base,
    performed_operation: null, operation_outcome: 'failed', effective_session_id: null,
    operation_witness: 'none', operation_request_digest: null, operation_response_digest: null,
    operation_rpc_id: null, operation_acknowledged_at: null, initialize_agent_info: null,
    identity_status: 'missing', effective_identity: null,
  }
  const failedLoad = {
    ...failedNew,
    requested_operation: 'load', requested_resume_session_id: 'sess_prev',
    prior_dispatch_id: 'prior_dispatch', prior_receipt_digest: priorDigest, resume_status: 'load_failed',
  }
  const interruptedNew = { ...failedNew, operation_outcome: 'interrupted' }
  const interruptedLoad = { ...failedLoad, operation_outcome: 'interrupted' }
  const valid = [
    ['new-default', base],
    ['new-agent-id-null', { ...base, agent_id: null }],
    ['new-agent-id-set', { ...base, agent_id: 'agent_1' }],
    ['new-initial-mode-read-only', { ...base, initial_agent_mode: 'read-only' }],
    ['new-initial-mode-agent', { ...base, initial_agent_mode: 'agent' }],
    ['new-requested-model-matched', { ...base, requested_model: 'model', effective_identity: 'model[ultra]', identity_status: 'matched' }],
    ['new-requested-effort', { ...base, requested_reasoning_effort: 'ultra' }],
    ['new-effective-identity-unverified', { ...base, effective_identity: 'model[ultra]' }],
    ['new-null-adapter-integrity', { ...base, adapter_integrity: null }],
    ['failed-new-after-initialize', { ...failedNew, initialize_agent_info: base.initialize_agent_info }],
    ['load-success', loadSuccess],
    ['load-success-agent-id', { ...loadSuccess, agent_id: 'load_agent' }],
    ['load-success-initial-mode', { ...loadSuccess, initial_agent_mode: 'agent-full-access' }],
    ['load-success-requested-model', { ...loadSuccess, requested_model: 'model', effective_identity: 'model[ultra]', identity_status: 'matched' }],
    ['load-success-requested-effort', { ...loadSuccess, requested_reasoning_effort: 'ultra' }],
    ['load-fallback', fallback],
    ['failed-new', failedNew],
    ['interrupted-new', interruptedNew],
    ['failed-load', failedLoad],
    ['interrupted-load', interruptedLoad],
  ]
  const invalid = [
    ['load-missing-requested-session', { ...loadSuccess, requested_resume_session_id: null }],
    ['load-missing-prior-dispatch', { ...loadSuccess, prior_dispatch_id: null }],
    ['load-missing-prior-digest', { ...loadSuccess, prior_receipt_digest: null }],
    ['load-performed-new', { ...loadSuccess, performed_operation: 'new', operation_witness: 'new_session_id_returned' }],
    ['load-requested-new', { ...loadSuccess, requested_operation: 'new', requested_resume_session_id: null, prior_dispatch_id: null, prior_receipt_digest: null, operation_witness: 'new_session_id_returned', resume_status: 'not_requested', performed_operation: 'load' }],
    ['load-wrong-witness', { ...loadSuccess, operation_witness: 'new_session_id_returned' }],
    ['load-wrong-resume-status', { ...loadSuccess, resume_status: 'not_requested' }],
    ['load-null-request-digest', { ...loadSuccess, operation_request_digest: null }],
    ['load-null-response-digest', { ...loadSuccess, operation_response_digest: null }],
    ['load-null-rpc-id', { ...loadSuccess, operation_rpc_id: null }],
    ['load-null-ack', { ...loadSuccess, operation_acknowledged_at: null }],
    ['load-null-initialize', { ...loadSuccess, initialize_agent_info: null }],
    ['load-outcome-failed-with-load', { ...loadSuccess, operation_outcome: 'failed', performed_operation: 'load', effective_session_id: null, operation_witness: 'none', operation_request_digest: null, operation_response_digest: null, operation_rpc_id: null, operation_acknowledged_at: null, initialize_agent_info: null, resume_status: 'load_failed' }],
    ['fallback-missing-prior-dispatch', { ...fallback, prior_dispatch_id: null }],
    ['fallback-missing-prior-digest', { ...fallback, prior_receipt_digest: null }],
    ['fallback-null-request-digest', { ...fallback, operation_request_digest: null }],
    ['fallback-null-response-digest', { ...fallback, operation_response_digest: null }],
    ['fallback-null-rpc-id', { ...fallback, operation_rpc_id: null }],
    ['fallback-null-ack', { ...fallback, operation_acknowledged_at: null }],
    ['fallback-null-initialize', { ...fallback, initialize_agent_info: null }],
    ['fallback-performed-load', { ...fallback, performed_operation: 'load', operation_witness: 'load_response_for_exact_request', resume_status: 'loaded' }],
    ['fallback-wrong-witness', { ...fallback, operation_witness: 'load_response_for_exact_request' }],
    ['fallback-wrong-status', { ...fallback, resume_status: 'loaded' }],
    ['fallback-requested-new', { ...fallback, requested_operation: 'new', requested_resume_session_id: null, prior_dispatch_id: null, prior_receipt_digest: null, resume_status: 'not_requested' }],
    ['fallback-null-effective-session', { ...fallback, effective_session_id: null }],
    ['fallback-claimed-success', { ...fallback, operation_outcome: 'succeeded', identity_status: 'matched', requested_model: 'model', effective_identity: 'model[ultra]' }],
    ['failed-load-missing-prior-dispatch', { ...failedLoad, prior_dispatch_id: null }],
    ['failed-load-missing-prior-digest', { ...failedLoad, prior_receipt_digest: null }],
    ['failed-load-performed-new', { ...failedLoad, performed_operation: 'new' }],
    ['failed-load-effective-session', { ...failedLoad, effective_session_id: 'sess_new' }],
    ['failed-load-witness', { ...failedLoad, operation_witness: 'new_session_id_returned' }],
    ['failed-load-wrong-status', { ...failedLoad, resume_status: 'unsupported_fallback' }],
    ['failed-new-performed-new', { ...failedNew, performed_operation: 'new' }],
    ['failed-new-effective-session', { ...failedNew, effective_session_id: 'sess_new' }],
    ['failed-new-witness', { ...failedNew, operation_witness: 'new_session_id_returned' }],
    ['failed-new-wrong-status', { ...failedNew, resume_status: 'load_failed' }],
    ['success-identity-missing', { ...base, identity_status: 'missing' }],
    ['success-identity-mismatched', { ...base, identity_status: 'mismatched' }],
    ['success-requested-model-unverified', { ...base, requested_model: 'model', effective_identity: 'model[ultra]' }],
    ['success-requested-model-no-effective', { ...base, requested_model: 'model', identity_status: 'matched', effective_identity: null }],
    ['ack-null-response-present', { ...base, operation_acknowledged_at: null }],
    ['response-null-ack-present', { ...base, operation_response_digest: null }],
    ['rpc-null-ack-present', { ...base, operation_rpc_id: null }],
    ['ack-invalid-precision', { ...base, operation_acknowledged_at: '2026-07-26T00:00:00.000000Z' }],
    ['response-malformed-digest', { ...base, operation_response_digest: 'sha256:not-a-digest' }],
    ['request-malformed-digest', { ...base, operation_request_digest: 'sha256:not-a-digest' }],
    ['prior-malformed-digest', { ...loadSuccess, prior_receipt_digest: 'not-a-digest' }],
    ['unsafe-task-id', { ...base, task_id: '../task' }],
    ['unsafe-dispatch-id', { ...base, dispatch_id: '../dispatch' }],
    ['unsafe-agent-id', { ...base, agent_id: '../agent' }],
    ['empty-worker', { ...base, worker: '' }],
    ['unknown-outcome', { ...base, operation_outcome: 'unknown' }],
    ['unknown-requested-operation', { ...base, requested_operation: 'resume' }],
    ['unknown-performed-operation', { ...base, performed_operation: 'resume' }],
    ['success-no-witness', { ...base, operation_witness: 'none' }],
    ['new-carries-prior-dispatch', { ...base, prior_dispatch_id: 'prior_dispatch' }],
    ['new-carries-prior-digest', { ...base, prior_receipt_digest: priorDigest }],
    ['new-carries-resume-session', { ...base, requested_resume_session_id: 'sess_prev' }],
    ['new-wrong-resume-status', { ...base, resume_status: 'loaded' }],
    ['empty-initial-mode', { ...base, initial_agent_mode: '' }],
  ]
  assert.equal(valid.length, 20)
  assert.equal(invalid.length, 60)
  const falseRejects = valid.filter(([name, value]) => !schemaMatches(schema, value)).map(([name]) => name)
  const falseAccepts = invalid.filter(([name, value]) => schemaMatches(schema, value)).map(([name]) => name)
  console.log(`[receipt-schema-matrix] valid=${valid.length} invalid=${invalid.length} false_accepts=${falseAccepts.length} false_rejects=${falseRejects.length}`)
  assert.deepEqual(falseRejects, [])
  assert.deepEqual(falseAccepts, [])
})

concurrentTest('default receipt persistence failure is explicit but does not silently block the legacy lane', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-receipt-optional-'))
  const r = await asyncRun('task-receipt-optional-failure', { ACP_TEST_RECEIPT_WRITE_FAILURE: '1' }, cwd)
  assert.equal(r.status, 0, `default receipt mode remains compatible; stderr:\n${r.stderr}`)
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'receipts')), true)
  assert.deepEqual(readdirSync(join(cwd, '.tmux-teams', 'receipts')).filter((name) => name.endsWith('.json')), [])
  const dispatch = readFileSync(join(cwd, '.tmux-teams', 'dispatch', 'task-receipt-optional-failure.md'), 'utf8')
  assert.match(dispatch, /^receipt_digest: none$/m)
  assert.match(readFileSync(join(cwd, '.mailbox-out', 'task-receipt-optional-failure'), 'utf8'), /^TEAM_DONE task-receipt-optional-failure$/m)
})

const CONTROLLER_SIGTERM_CASES = [['initialize', ''], ['new', ''], ['load', 'sess_prev']]

test('controller SIGTERM during startup creates no prompt and reaps each adapter', { concurrency: 3 }, async (t) => {
  const settled = await Promise.allSettled(CONTROLLER_SIGTERM_CASES.map(([stage, resume]) => (
    t.test(`controller SIGTERM during ${stage} creates no prompt and reaps the adapter`, async () => {
    const taskId = `task-controller-${stage}`
    const cwd = mkdtempSync(join(tmpdir(), `acp-companion-controller-${stage}-`))
    const protocolLog = join(cwd, 'protocol.log')
    const live = liveRun(taskId, {
      MOCK_SCENARIO: 'startup-stall', MOCK_STALL_STAGE: stage, ACP_RESUME: resume,
      ACP_PROTOCOL_LOG: protocolLog, MOCK_PROTOCOL_LOG: protocolLog,
      ACP_CANCEL_GRACE_MS: '30', ACP_PROCESS_KILL_GRACE_MS: '40', MOCK_SPAWN_DESCENDANT: '1',
    }, cwd, 1)
    await waitForStage(join(cwd, 'stages.log'), `request-${stage === 'initialize' ? 'initialize' : stage === 'new' ? 'session-new' : 'session-load'}-sent`)
    assert.equal(live.child.kill('SIGTERM'), true)
    const result = await live.completion
    assert.notEqual(result.status, 0, `interruption must be nonzero; stderr:\n${result.stderr}`)
    const state = snapshot(cwd, taskId)
    assert.ok(['stalled', 'failed'].includes(state.liveness_state))
    assert.deepEqual(state.active_tools, [])
    const transcript = existsSync(protocolLog) ? readFileSync(protocolLog, 'utf8') : ''
    assert.equal(transcript.includes('session/prompt'), false)
    const events = eventTexts(cwd)
    assert.equal(events.length, 1)
    assert.match(events[0], /^child_settlement_signal_delivered: true$/m)
    await assertPidGone(descendantPid(cwd), `${stage} controller interruption`)
    })
  )))
  const failure = settled.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
})

test('controller signal persistence failure remains explicitly unavailable', async () => {
  const taskId = 'task-controller-signal-persistence-unavailable'
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-controller-signal-unavailable-'))
  const live = liveRun(taskId, {
    MOCK_SCENARIO: 'startup-stall', MOCK_STALL_STAGE: 'new',
    ACP_TEST_CONTROLLER_SIGNAL_PERSISTENCE_FAILURE: '1',
    ACP_CANCEL_GRACE_MS: '30', ACP_PROCESS_KILL_GRACE_MS: '40',
  }, cwd, 1)
  await waitForStage(join(cwd, 'stages.log'), 'request-session-new-sent')
  assert.equal(live.child.kill('SIGTERM'), true)
  const result = await live.completion
  assert.notEqual(result.status, 0)
  const event = eventTexts(cwd)[0]
  assert.match(event, /^controller_signal_provenance_durable: false$/m)
  await assertPidGone(descendantPid(cwd), 'unavailable signal provenance')
})

test('controller signal during receipt commit fences prompt and preserves the committed receipt', async () => {
  const taskId = 'task-controller-receipt-commit'
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-controller-receipt-'))
  const profile = writeExecutionProfile(cwd)
  const protocolLog = join(cwd, 'protocol.log')
  const live = liveRun(taskId, {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
    ACP_TEST_RECEIPT_COMMIT_DELAY_MS: '300', MOCK_PROTOCOL_LOG: protocolLog,
    ACP_CANCEL_GRACE_MS: '30', ACP_PROCESS_KILL_GRACE_MS: '40', MOCK_SPAWN_DESCENDANT: '1',
  }, cwd, 1)
  await waitForStage(join(cwd, 'stages.log'), 'receipt-commit-start')
  assert.equal(live.child.kill('SIGTERM'), true)
  const result = await live.completion
  assert.notEqual(result.status, 0)
  const transcript = readFileSync(protocolLog, 'utf8')
  assert.equal(transcript.includes('session/prompt'), false)
  const dir = join(cwd, '.tmux-teams', 'receipts')
  assert.equal(readdirSync(dir).length, 1)
  JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'))
  await assertPidGone(descendantPid(cwd), 'receipt-commit interruption')
})

test('controller signal after exact load response fences the pre-receipt barrier', async () => {
  const taskId = 'task-controller-load-pre-receipt'
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-controller-load-pre-receipt-'))
  const profile = writeExecutionProfile(cwd)
  const first = run(taskId, {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'new', ACP_EXECUTION_PROFILE: profile,
  }, cwd)
  assert.equal(first.status, 0, `lineage seed must complete; stderr:\n${first.stderr}`)
  const firstDispatch = field(readFileSync(join(cwd, '.tmux-teams', 'dispatch', `${taskId}.md`), 'utf8'), 'dispatch_id')
  const firstReceipt = receiptFor(cwd, firstDispatch)
  const release = join(cwd, 'release-pre-receipt')
  const protocolLog = join(cwd, 'load-pre-receipt.protocol.log')
  const control = join(cwd, 'load-pre-receipt.control.log')
  const live = liveRun(taskId, {
    ACP_SESSION_RECEIPT_REQUIRED: '1', ACP_SESSION_OPERATION: 'load',
    ACP_RESUME: firstReceipt.value.effective_session_id,
    ACP_PRIOR_DISPATCH_ID: firstDispatch,
    ACP_PRIOR_RECEIPT_DIGEST: digest(firstReceipt.raw),
    ACP_EXECUTION_PROFILE: profile,
    ACP_TEST_GATE_STAGE: 'pre-receipt', ACP_TEST_GATE_RELEASE_FILE: release,
    ACP_TEST_GATE_WATCHDOG_MS: '15000', ACP_CONTROL_LOG: control,
    MOCK_PROTOCOL_LOG: protocolLog, MOCK_CANCEL_RESPOND: '0',
    ACP_CANCEL_GRACE_MS: '30', ACP_PROCESS_KILL_GRACE_MS: '40',
  }, cwd, 1)
  await waitForStage(join(cwd, 'stages.log'), 'response-session-load-correlated', 60_000)
  await waitForStage(join(cwd, 'stages.log'), 'pre-receipt-reached', 60_000)
  assert.equal(live.child.kill('SIGTERM'), true)
  await waitForStage(join(cwd, 'stages.log'), 'controller-signal-latched', 60_000)
  writeFileSync(release, 'release\n', { mode: 0o600 })
  const result = await live.completion
  assert.notEqual(result.status, 0, `interrupted load must fail; stderr:\n${result.stderr}`)
  const transcript = readFileSync(protocolLog, 'utf8')
  assert.equal(transcript.includes('session/prompt'), false)
  const dispatch = readFileSync(join(cwd, '.tmux-teams', 'dispatch', `${taskId}.md`), 'utf8')
  const secondDispatch = field(dispatch, 'dispatch_id')
  const secondReceipt = receiptFor(cwd, secondDispatch)
  assert.equal(secondReceipt.value.operation_outcome, 'interrupted')
  assert.equal(secondReceipt.value.performed_operation, null)
  assert.equal(secondReceipt.value.effective_session_id, null)
  assert.equal(secondReceipt.value.resume_status, 'load_failed')
  const controlText = readFileSync(control, 'utf8')
  const cancelIndex = controlText.indexOf('session/cancel')
  const graceIndex = controlText.indexOf('grace')
  assert.ok(cancelIndex >= 0)
  if (graceIndex >= 0) assert.ok(graceIndex > cancelIndex, controlText)
  const processSignalMatches = [...controlText.matchAll(CANCEL_LADDER_SIGNAL)]
  if (processSignalMatches.length > 0) assert.ok(graceIndex >= 0 && processSignalMatches[0].index > graceIndex, controlText)
})

test('controller signal during an in-progress tool is cancel-first and leaves no descendant', async () => {
  const taskId = 'task-controller-tool'
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-controller-tool-'))
  const control = join(cwd, 'control.log')
  const live = liveRun(taskId, {
    MOCK_SCENARIO: 'silent-tool', MOCK_TOOL_DELAY_MS: '1000', MOCK_SPAWN_DESCENDANT: '1',
    ACP_CONTROL_LOG: control, ACP_CANCEL_GRACE_MS: '500', ACP_PROCESS_KILL_GRACE_MS: '40',
  }, cwd, 1)
  await waitForStage(join(cwd, 'stages.log'), 'tool-running')
  assert.equal(live.child.kill('SIGTERM'), true)
  await waitForStage(join(cwd, 'stages.log'), 'cancel-grace')
  assert.equal(live.child.kill('SIGINT'), true)
  const result = await live.completion
  assert.notEqual(result.status, 0)
  const controlText = readFileSync(control, 'utf8')
  assert.ok(controlText.indexOf('session/cancel') >= 0)
  assert.ok(controlText.indexOf('grace') > controlText.indexOf('session/cancel'))
  const processSignalMatches = [...controlText.matchAll(CANCEL_LADDER_SIGNAL)]
  const processSignalIndex = processSignalMatches.length ? processSignalMatches[0].index : -1
  assert.ok(processSignalIndex > controlText.indexOf('grace'), controlText)
  assert.ok(controlText.includes('controller signal SIGTERM'))
  assert.ok(controlText.includes('controller signal SIGINT'))
  const event = eventTexts(cwd)[0]
  assert.match(event, /^controller_interrupted: true$/m)
  assert.match(event, /^controller_signal_count: 2$/m)
  assert.match(event, /^controller_second_signal: SIGINT$/m)
  await assertPidGone(descendantPid(cwd), 'tool controller interruption')
})

test('controller signal during prompt fence never emits a prompt request', async () => {
  const taskId = 'task-controller-prompt'
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-controller-prompt-'))
  const protocolLog = join(cwd, 'protocol.log')
  const live = liveRun(taskId, {
    ACP_TEST_PROMPT_DELAY_MS: '250', MOCK_PROTOCOL_LOG: protocolLog,
    ACP_CANCEL_GRACE_MS: '30', ACP_PROCESS_KILL_GRACE_MS: '40',
  }, cwd, 1)
  await waitForStage(join(cwd, 'stages.log'), 'pre-prompt')
  assert.equal(live.child.kill('SIGTERM'), true)
  const result = await live.completion
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(protocolLog, 'utf8').includes('session/prompt'), false)
})

concurrentTest('records one mechanical KMS event without inventing a PM judgement', async () => {
  const r = await asyncRun('task-kms')
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const events = eventTexts(r.cwd)
  assert.equal(events.length, 1)
  const footprint = readFileSync(join(r.cwd, '.tmux-teams', 'dispatch', 'task-kms.md'), 'utf8')
  const dispatchId = field(footprint, 'dispatch_id')
  assert.match(dispatchId, UUID_RE)
  assert.equal(field(events[0], 'dispatch_id'), dispatchId, 'footprint and terminal event identify the same dispatch')
  assert.match(events[0], /^event_kind: transport-terminal$/m)
  assert.match(events[0], /^task_id: task-kms$/m)
  assert.match(events[0], /^worker: mock$/m)
  assert.match(events[0], /^transport: acp$/m)
  assert.match(events[0], /^terminal: done$/m)
  assert.match(events[0], /^exit_code: 0$/m)
  assert.match(events[0], /^evidence_present: false$/m)
  assert.match(events[0], /^timed_out: false$/m)
  assert.match(events[0], /^started_at: \d{4}-\d{2}-\d{2}T/m)
  assert.doesNotMatch(events[0], /^pm_verdict:/m)
  assert.doesNotMatch(events[0], /^lesson:/m)
  assert.doesNotMatch(footprint, /^active_tool_evidence:/m)
})

test('a retired delivery phase is refused before dispatch, ACP, or KMS side effects', () => {
  // The four-stage phase system went in v0.14.0; this variable kept checking
  // names against its vocabulary for a release after it, so an operator running
  // a companion by hand for a team called `control` was told to use words that
  // describe nothing. Nothing ever set it — no runner, no script, no skill — so
  // it is retired the way the phase gate above it was, rather than being widened
  // into a label pulse would discard as `unassigned`.
  for (const value of ['Development', 'control', '']) {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-retired-phase-'))
    const r = run('task-retired-phase', { TMUX_TEAMS_PHASE: value }, cwd)
    assert.equal(r.status, 2, `TMUX_TEAMS_PHASE=${JSON.stringify(value)} was accepted`)
    assert.match(r.stderr, /PHASE_RETIRED/)
    assert.equal(existsSync(join(cwd, '.tmux-teams', 'dispatch')), false)
    assert.deepEqual(eventTexts(cwd), [])
  }
})

concurrentTest('a dispatch no longer writes a phase line at all', async () => {
  const r = await asyncRun('task-no-phase', {})
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const footprint = readFileSync(join(r.cwd, '.tmux-teams', 'dispatch', 'task-no-phase.md'), 'utf8')
  assert.doesNotMatch(footprint, /^phase:/m)
  assert.doesNotMatch(eventTexts(r.cwd)[0], /^phase:/m)
})

test('a governed marker cannot be bypassed by invoking the raw companion', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-governed-bypass-'))
  mkdirSync(join(cwd, '.tmux-teams'), { recursive: true })
  writeFileSync(join(cwd, '.tmux-teams', 'phase-gate.json'), '{malformed')
  const result = run('task-governed-bypass', {}, cwd)
  assert.equal(result.status, 2)
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'dispatch')), false)
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'sessions')), false)
  assert.deepEqual(eventTexts(cwd), [])
})

concurrentTest('a repeated task id gets a fresh dispatch UUID without changing legacy paths', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-'))
  const first = await asyncRun('task-repeat', {}, cwd)
  assert.equal(first.status, 0, `first exit 0 expected; stderr:\n${first.stderr}`)
  const footprintPath = join(cwd, '.tmux-teams', 'dispatch', 'task-repeat.md')
  const firstId = field(readFileSync(footprintPath, 'utf8'), 'dispatch_id')

  const second = await asyncRun('task-repeat', {}, cwd)
  assert.equal(second.status, 0, `second exit 0 expected; stderr:\n${second.stderr}`)
  const secondId = field(readFileSync(footprintPath, 'utf8'), 'dispatch_id')

  assert.notEqual(secondId, firstId)
  assert.deepEqual(readdirSync(join(cwd, '.tmux-teams', 'dispatch')), ['task-repeat.md'])
  assert.deepEqual(eventTexts(cwd).map(text => field(text, 'dispatch_id')), [firstId, secondId])
})

concurrentTest('records whether the terminal outbox contains concrete evidence', async () => {
  const r = await asyncRun('task-evidence', { MOCK_EVIDENCE: '1' })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.match(eventTexts(r.cwd)[0], /^evidence_present: true$/m)
})

for (const [mode, status, terminal] of [
  ['blocked', 0, 'blocked'],
  ['failed', 0, 'failed'],
  ['invalid', 3, 'invalid'],
  ['missing', 3, 'no-outbox'],
]) {
  concurrentTest(`records the ${terminal} terminal path`, async () => {
    const r = await asyncRun(`task-${mode}`, { MOCK_TERMINAL: mode })
    assert.equal(r.status, status, `exit ${status} expected; stderr:\n${r.stderr}`)
    const events = eventTexts(r.cwd)
    assert.equal(events.length, 1)
    assert.match(events[0], new RegExp(`^terminal: ${terminal}$`, 'm'))
    assert.match(events[0], new RegExp(`^exit_code: ${status}$`, 'm'))
  })
}

concurrentTest('ACP_KMS_AUTO=0 opts out of the automatic event', async () => {
  const r = await asyncRun('task-optout', { ACP_KMS_AUTO: '0' })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.deepEqual(eventTexts(r.cwd), [])
})

concurrentTest('records an agent that exits before completing the protocol', async () => {
  const r = await asyncRun('task-early-exit', { MOCK_EXIT_EARLY: '1' })
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const events = eventTexts(r.cwd)
  assert.equal(events.length, 1)
  assert.match(events[0], /^terminal: agent-exit$/m)
  assert.match(events[0], /^exit_code: 9$/m)
})

concurrentTest('records an agent command that cannot be spawned', async () => {
  const r = await asyncRun('task-spawn-error', { ACP_CMD: 'tmux-teams-no-such-acp-agent' })
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const events = eventTexts(r.cwd)
  assert.equal(events.length, 1)
  assert.match(events[0], /^terminal: spawn-error$/m)
  assert.match(events[0], /^exit_code: 1$/m)
})

for (const [taskId, extraEnv, expectedMode] of [
  ['task-codex-mode-default', {}, 'agent-full-access'],
  ['task-codex-mode-override', { INITIAL_AGENT_MODE: 'read-only' }, 'read-only'],
]) {
  concurrentTest(`Codex ACP receives ${expectedMode} INITIAL_AGENT_MODE`, async () => {
    const r = await asyncRun(taskId, extraEnv, undefined, 30, 'codex')
    assert.equal(r.status, 0, `exit 0 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
    assert.equal(readFileSync(join(r.cwd, '.initial-agent-mode'), 'utf8').trim(), expectedMode)
    assert.equal(receipt(r.cwd).value.initial_agent_mode, expectedMode)
  })
}

test('Codex rejects an invalid INITIAL_AGENT_MODE before spawn or bookkeeping', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-invalid-mode-'))
  const r = runAs('codex', 'task-invalid-codex-mode', { INITIAL_AGENT_MODE: 'interactive' }, cwd)
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
  assert.equal(existsSync(join(cwd, '.tmux-teams')), false)
})

concurrentTest('non-Codex ACP preserves an explicit INITIAL_AGENT_MODE unchanged', async () => {
  const r = await asyncRun('task-noncodex-mode', { INITIAL_AGENT_MODE: 'interactive' }, undefined, 30, 'mock')
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.equal(readFileSync(join(r.cwd, '.initial-agent-mode'), 'utf8').trim(), 'interactive')
})

test('producer-derived v1 fixtures satisfy semantic invariants and separate lifecycle histories', async () => {
  const toolFixture = fixture(LIVENESS_FIXTURE)
  const startupFixture = fixture(STARTUP_FIXTURE)
  const recoveryFixture = fixture(RECOVERY_FIXTURE)
  assertV1Semantics(toolFixture, { expectedState: 'tool_running', expectCancellationUnavailable: false })
  assertV1Semantics(startupFixture, { expectedState: 'failed', expectCancellationUnavailable: true })
  assertV1Semantics(recoveryFixture, { expectedState: 'completed', expectCancellationUnavailable: false })
  assert.ok(toolFixture.stall_history.every((event) => event.state !== 'cancellation_unavailable'))
  assert.ok(startupFixture.stall_history.some((event) => event.state === 'cancellation_unavailable'))
  assert.ok(recoveryFixture.stall_history.some((event) => event.state === 'recovered'))
  assert.ok(recoveryFixture.stall_history.some((event) => event.state === 'stalled'))

  await forEachConcurrent([
    async () => {
      const toolTask = 'fixture-tool-running'
      const toolCwd = mkdtempSync(join(tmpdir(), 'acp-companion-fixture-tool-'))
      const toolPending = asyncRun(toolTask, {
        MOCK_SCENARIO: 'silent-tool',
        MOCK_TOOL_DELAY_MS: '500',
        ACP_LIVENESS_TICK_MS: '10',
        ACP_AGENT_ID: toolFixture.agent_id,
        ACP_EXPECT_MODEL: toolFixture.requested_model,
        ACP_EXPECT_REASONING_EFFORT: toolFixture.requested_reasoning_effort,
      }, toolCwd, 60, 'codex')
      await waitForStage(join(toolCwd, 'stages.log'), 'tool-running')
      const producedTool = snapshot(toolCwd, toolTask)
      assertV1Semantics(producedTool, { expectedState: 'tool_running', expectCancellationUnavailable: false })
      assert.deepEqual(normalizeFixtureSnapshot(producedTool), normalizeFixtureSnapshot(toolFixture))
      await toolPending
    },
    async () => {
      const startup = await asyncRun('fixture-startup-stall', {
        MOCK_SCENARIO: 'startup-stall',
        MOCK_STALL_STAGE: 'initialize',
        ACP_HARD_TIMEOUT_SEC: '0.09',
        ACP_PROCESS_KILL_GRACE_MS: '40',
        ACP_AGENT_ID: startupFixture.agent_id,
        ACP_EXPECT_MODEL: startupFixture.requested_model,
        ACP_EXPECT_REASONING_EFFORT: startupFixture.requested_reasoning_effort,
      }, undefined, 60, 'codex')
      assert.equal(startup.status, 1, `startup fixture producer failed:\n${startup.stderr}`)
      const producedStartup = snapshot(startup.cwd, 'fixture-startup-stall')
      assertV1Semantics(producedStartup, { expectedState: 'failed', expectCancellationUnavailable: true })
      assert.deepEqual(normalizeFixtureSnapshot(producedStartup), normalizeFixtureSnapshot(startupFixture))
    },
    async () => {
      const recoveryCwd = mkdtempSync(join(tmpdir(), 'acp-companion-fixture-recovery-'))
      const recoveryInitializeRelease = join(recoveryCwd, 'release-initialize')
      const recoveryRelease = join(recoveryCwd, 'release-recovery')
      const recoveryPending = asyncRun('fixture-recovery', {
        MOCK_SCENARIO: 'report-recover',
        MOCK_GATE_STAGE: 'initialize',
        MOCK_GATE_RELEASE_FILE: recoveryInitializeRelease,
        MOCK_RECOVERY_GATE_FILE: recoveryRelease,
        MOCK_GATE_WATCHDOG_MS: '15000',
        ACP_LIVENESS_TICK_MS: '20',
        ACP_STALL_POLICY: 'report',
        ACP_AGENT_ID: recoveryFixture.agent_id,
        ACP_EXPECT_MODEL: recoveryFixture.requested_model,
        ACP_EXPECT_REASONING_EFFORT: recoveryFixture.requested_reasoning_effort,
      }, recoveryCwd, 1.5, 'codex')
      await waitForStage(join(recoveryCwd, 'stages.log'), 'suspected-stalled')
      writeFileSync(recoveryInitializeRelease, 'release\n', { mode: 0o600 })
      await waitForStage(join(recoveryCwd, 'stages.log'), 'stalled')
      writeFileSync(recoveryRelease, 'release\n', { mode: 0o600 })
      const recovery = await recoveryPending
      assert.equal(recovery.status, 0, `recovery fixture producer failed:\n${recovery.stderr}`)
      const producedRecovery = snapshot(recovery.cwd, 'fixture-recovery')
      assertV1Semantics(producedRecovery, { expectedState: 'completed', expectCancellationUnavailable: false })
      assert.ok(producedRecovery.stall_history.some((event) => event.state === 'recovered'))
      assert.deepEqual(normalizeFixtureSnapshot(producedRecovery), normalizeFixtureSnapshot(recoveryFixture))
    },
  ], 3, (producer) => producer())
})

concurrentTest('ACP_AGENT_ID is validated and reaches dispatch, liveness, and KMS without changing worker identity', async () => {
  const r = await asyncRun('task-agent-id', { ACP_AGENT_ID: 'graph-worker-a' })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const dispatch = readFileSync(join(r.cwd, '.tmux-teams', 'dispatch', 'task-agent-id.md'), 'utf8')
  const event = eventTexts(r.cwd)[0]
  assert.equal(field(dispatch, 'agent_id'), 'graph-worker-a')
  assert.equal(field(event, 'agent_id'), 'graph-worker-a')
  assert.equal(snapshot(r.cwd, 'task-agent-id').agent_id, 'graph-worker-a')
  assert.equal(field(event, 'worker'), 'mock')
  assert.equal(field(event, 'transport'), 'acp')
})

test('an invalid ACP_AGENT_ID fails closed before spawn or bookkeeping', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-invalid-agent-id-'))
  const r = run('task-invalid-agent-id', { ACP_AGENT_ID: 'graph/worker' }, cwd)
  assert.equal(r.status, 2)
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'dispatch')), false)
  assert.equal(existsSync(join(cwd, '.tmux-teams', 'liveness')), false)
  assert.deepEqual(eventTexts(cwd), [])
})

test('an invalid ACP_PROCESS_REAP_GRACE_MS fails closed before spawn or bookkeeping', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-invalid-reap-grace-'))
  const r = run('task-invalid-reap-grace', { ACP_PROCESS_REAP_GRACE_MS: 'not-a-number' }, cwd)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /invalid ACP_PROCESS_REAP_GRACE_MS/)
  assert.equal(existsSync(join(cwd, '.tmux-teams')), false)
  assert.equal(existsSync(join(cwd, '.initial-agent-mode')), false)
})

test('unset ACP_PROCESS_REAP_GRACE_MS preserves the historical one-second clean-exit floor', async () => {
  const taskId = 'task-default-reap-grace'
  const r = await asyncRun(taskId, {
    ACP_PROCESS_REAP_GRACE_MS: null,
    ACP_PROCESS_KILL_GRACE_MS: '20',
    MOCK_STDIN_END_DELAY_MS: '400',
  })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  assert.doesNotMatch(r.stderr, /\[reap\] signal SIGTERM/)
  const event = eventTexts(r.cwd)[0]
  assert.match(event, /^child_exit_code: 0$/m)
  assert.match(event, /^child_signal: none$/m)
  assert.match(event, /^child_settlement_signal_delivered: false$/m)
})

concurrentTest('persisted producer metadata is field-bounded, redacted, and remains under 64 KiB', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-bounded-fields-'))
  const secret = 'sk-r3-persisted-secret-12345678901234567890'
  const modelPath = '/tmp/provider-model'
  const r = await asyncRun('task-bounded-fields', {
    MOCK_SCENARIO: 'metadata-overflow',
    MOCK_SESSION_ID: `session-${'x'.repeat(180)} token=${secret}`,
    MOCK_MODEL: `model-${modelPath}-${'m'.repeat(220)} apiKey=${secret}`,
    MOCK_REASONING_EFFORT: `reason-${'r'.repeat(160)} password=${secret}`,
    MOCK_STDERR: `adapter error ${'e'.repeat(500)} password=${secret}`,
    ACP_EXPECT_MODEL: `model-${modelPath}-${'m'.repeat(220)} apiKey=${secret}`,
    ACP_EXPECT_REASONING_EFFORT: `reason-${'r'.repeat(160)} password=${secret}`,
  }, cwd, 30, `provider-${'x'.repeat(180)}-${secret}`)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const liveRaw = readFileSync(join(cwd, '.tmux-teams', 'liveness', 'task-bounded-fields.json'), 'utf8')
  assert.ok(Buffer.byteLength(liveRaw, 'utf8') <= 64 * 1024)
  const state = JSON.parse(liveRaw)
  assert.ok(state.worker.length <= 64)
  assert.ok(state.session_id.length <= 128)
  assert.ok(state.requested_model.length <= 128)
  assert.ok(state.requested_reasoning_effort.length <= 64)
  assert.ok(state.termination_reason.length <= 64)
  for (const tool of Object.values(state.tools)) assertToolRecord(tool, 'bounded tool')
  const artifacts = persistedArtifacts(cwd, 'task-bounded-fields')
  const sessionReceipt = receipt(cwd)
  assert.ok(field(artifacts[1], 'worker').length <= 64)
  assert.ok(field(artifacts[1], 'requested_model').length <= 128)
  assert.ok(field(artifacts[1], 'requested_reasoning_effort').length <= 64)
  assert.ok(field(artifacts[1], 'error').length <= 512)
  assert.ok(field(artifacts[2], 'worker').length <= 64)
  assert.ok(field(artifacts[2], 'session_id').length <= 128)
  assert.ok(field(artifacts[2], 'error').length <= 512)
  for (const artifact of artifacts) {
    assert.ok(!artifact.includes(secret), 'secret must not reach liveness, dispatch, or KMS')
    assert.ok(!artifact.includes('password='), 'password-shaped text must be redacted')
    assert.ok(!artifact.includes('apiKey='), 'api-key-shaped text must be redacted')
  }
  assert.ok(sessionReceipt.value.requested_model.length <= 256)
  assert.ok(sessionReceipt.value.requested_reasoning_effort.length <= 256)
  assert.ok(sessionReceipt.value.effective_identity.length <= 256)
  assert.ok(!sessionReceipt.raw.includes(secret))
  assert.ok(!sessionReceipt.raw.includes('password='))
  assert.ok(!sessionReceipt.raw.includes('apiKey='))
  assert.ok(!sessionReceipt.raw.includes('token='))
  assert.doesNotMatch(sessionReceipt.raw, /(?:\/home|\/tmp)\//)
})

concurrentTest('invalid ACP tool status fails closed instead of being persisted or counted as progress', async () => {
  const r = await asyncRun('task-invalid-tool-status', { MOCK_SCENARIO: 'invalid-tool-status' })
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, 'task-invalid-tool-status')
  assertV1Semantics(state, { expectedState: 'failed', expectCancellationUnavailable: false })
  assert.equal(state.meaningful_progress_count, 3, 'invalid tool status must not add progress beyond initialize/new/prompt response')
  assert.equal(Object.values(state.tools).some((tool) => tool.status === 'totally-invalid'), false)
  assert.ok(Object.values(state.tools).every((tool) => TOOL_STATUSES.has(tool.status)))
  assert.ok(!persistedArtifacts(r.cwd, 'task-invalid-tool-status').join('\n').includes('totally-invalid'))
  assert.match(eventTexts(r.cwd)[0], /^terminal: protocol-error$/m)
})

const STARTUP_STALL_CASES = [['initialize', ''], ['new', ''], ['load', 'sess_prev']]

test('startup requests become suspected then confirmed stalled without a hard ceiling', { concurrency: 3 }, async (t) => {
  const settled = await Promise.allSettled(STARTUP_STALL_CASES.map(([stage, resume]) => (
    t.test(`${stage} startup request can become suspected then confirmed stalled without a hard ceiling`, async () => {
    const taskId = `task-startup-stall-${stage}`
    const r = await asyncRun(taskId, {
      MOCK_SCENARIO: 'startup-stall',
      MOCK_STALL_STAGE: stage,
      ACP_RESUME: resume,
      ACP_CANCEL_GRACE_MS: '20',
      ACP_PROCESS_KILL_GRACE_MS: '30',
    }, undefined, 0.045)
    assert.equal(r.status, 1, `exit 1 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
    const state = snapshot(r.cwd, taskId)
    assert.equal(state.hard_timeout_sec, 0)
    assert.equal(state.liveness_state, 'stalled')
    assert.equal(state.termination_reason, 'stall_confirmed')
    assert.equal(state.consecutive_missed_leases, 2)
    assert.ok(state.stall_history.some((entry) => entry.state === 'suspected_stalled'))
    assert.match(eventTexts(r.cwd)[0], /^terminal: stalled$/m)
    })
  )))
  const failure = settled.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
})

test('report-only confirms, recovers, and completes without ACP cancellation', async () => {
  const taskId = 'task-report-recover'
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-report-recover-'))
  const release = join(cwd, 'release-recovery')
  const pending = asyncRun(taskId, {
    MOCK_SCENARIO: 'report-recover',
    MOCK_RECOVERY_GATE_FILE: release,
    MOCK_GATE_WATCHDOG_MS: '15000',
    MOCK_SPAWN_DESCENDANT: '1',
    ACP_STALL_POLICY: 'report',
    ACP_PROCESS_KILL_GRACE_MS: '100',
    ACP_PROCESS_REAP_GRACE_MS: '600',
  }, cwd, 0.5)
  await waitForStage(join(cwd, 'stages.log'), 'stalled')
  writeFileSync(release, 'release\n', { mode: 0o600 })
  const r = await pending
  assert.equal(r.status, 0, `exit 0 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.equal(existsSync(join(r.cwd, '.cancel-seen')), false)
  const state = snapshot(r.cwd, taskId)
  assert.equal(state.liveness_state, 'completed')
  assert.equal(state.termination_reason, 'none')
  assert.ok(state.stall_history.some((entry) => entry.state === 'suspected_stalled'))
  assert.ok(state.stall_history.some((entry) => entry.state === 'stalled'))
  assert.ok(state.stall_history.some((entry) => entry.state === 'recovered'))
  await assertPidGone(descendantPid(r.cwd), 'report-only completion')
})

test('an in-progress ACP tool spans multiple inactivity leases without hard-timeout cancellation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-long-tool-'))
  const r = run('task-long-in-progress-tool', {
    MOCK_SCENARIO: 'silent-tool',
    MOCK_TOOL_DELAY_MS: '1200',
    ACP_HARD_TIMEOUT_SEC: '0',
    ACP_LIVENESS_TICK_MS: '10',
    ACP_CANCEL_GRACE_MS: '20',
    ACP_PROCESS_KILL_GRACE_MS: '50',
  }, cwd, 0.5)
  assert.equal(r.status, 0, `exit 0 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.equal(existsSync(join(cwd, '.cancel-seen')), false)
  const state = snapshot(cwd, 'task-long-in-progress-tool')
  assert.equal(state.hard_timeout_sec, 0)
  assert.equal(state.liveness_state, 'completed')
  assert.equal(state.tools.t1.status, 'completed')
  assert.equal(state.tools.t1.update_count, 2)
})

test('a tool that goes quiet for two whole leases stops vouching for the run', async () => {
  // The sibling test above proves a long tool is not cancelled for being slow.
  // This one proves it cannot be immortal: `in_progress` used to renew the lease
  // unconditionally, so one hung tool call — a request that never returned, a
  // command waiting on input nobody will type — kept a dead run alive for ever,
  // while the message path next door fingerprints its text precisely so an agent
  // repeating itself cannot do the same thing.
  //
  // A tool now renews only while it is itself fresh by the operator's own
  // `stallSec`, and then the ORDINARY two-miss path decides. So the tolerance is
  // unchanged in kind — suspected first, confirmed only on the second miss — and
  // 3000ms of silence against a 500ms lease is past both.
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-hung-tool-'))
  const r = run('task-hung-tool', {
    MOCK_SCENARIO: 'silent-tool',
    MOCK_TOOL_DELAY_MS: '3000',
    ACP_HARD_TIMEOUT_SEC: '0',
    ACP_LIVENESS_TICK_MS: '10',
    ACP_CANCEL_GRACE_MS: '20',
    ACP_PROCESS_KILL_GRACE_MS: '50',
  }, cwd, 0.5)
  const state = snapshot(cwd, 'task-hung-tool')
  // The outcome before the words about it: the run did not sit there.
  assert.equal(state.liveness_state, 'stalled')
  assert.equal(r.status, 1, `exit 1 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.equal(existsSync(join(cwd, '.cancel-seen')), true, 'a confirmed stall cancels the session')
  assert.equal(state.hard_timeout_sec, 0, 'nothing here came from a hard ceiling')
  assert.equal(state.tools.t1.status, 'in_progress', 'the tool never reported again — that is the point')
})

test('a permission request raised after cancellation is answered cancelled, not approved', () => {
  // ACP v1 prompt-turn, Cancellation: "The Client MUST respond to all pending
  // `session/request_permission` requests with the `cancelled` outcome."
  //
  // Until 2026-08-13 this file's subject auto-approved every permission request
  // regardless of state, so a run that had already sent `session/cancel` would
  // still hand the agent another tool call. The mock raises one deliberately on
  // receiving the cancel and writes back whatever outcome it was given, so this
  // asserts the ANSWER the agent received rather than a branch being present.
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-perm-after-cancel-'))
  const r = run('task-perm-after-cancel', {
    MOCK_SCENARIO: 'silent-tool',
    MOCK_TOOL_DELAY_MS: '3000',
    MOCK_PERMISSION_AFTER_CANCEL: '1',
    ACP_HARD_TIMEOUT_SEC: '0',
    ACP_LIVENESS_TICK_MS: '10',
    ACP_CANCEL_GRACE_MS: '200',
    ACP_PROCESS_KILL_GRACE_MS: '200',
  }, cwd, 0.5)
  assert.equal(existsSync(join(cwd, '.cancel-seen')), true,
    `the run must reach cancellation for this test to mean anything; stderr:\n${r.stderr}`)
  const answerPath = join(cwd, '.permission-after-cancel')
  assert.equal(existsSync(answerPath), true,
    `the agent never received an answer to its post-cancel permission request; stderr:\n${r.stderr}`)
  assert.match(readFileSync(answerPath, 'utf8').trim(), /^cancelled:/,
    'a permission request raised after cancellation was answered with something other than cancelled')
})

// NOT TESTED, DELIBERATELY, AND HERE IS WHY — the SHOULD in the same ACP
// paragraph: "The Client SHOULD preemptively mark all non-finished tool calls
// pertaining to the current turn as `cancelled`." `beginCancellation` clears
// `activeToolIds` for it (2026-08-13), and that change has NO behavioural test.
//
// A test was written and then deleted, because a mutation proved it vacuous:
// `currentActiveToolEvidence()` returns `[]` whenever the liveness state is
// terminal, so the FINAL snapshot every test reads is empty whether the clear
// happens or not. Removing the production change left 134/134 green. The effect
// is real but lives only in the transient `cancelling` window, and reading the
// liveness file mid-run is a race, not an assertion.
//
// Two things a future author should know rather than rediscover. ACP v1 defines
// no `cancelled` tool status at all — pending, in_progress, completed, failed is
// the whole set — so the literal word cannot be written without amending a
// frozen schema, which would be a decision and not a fix. And the first probe
// run against this looked like proof the code never executed, because it
// checked a control log that is only written when `ACP_CONTROL_LOG` is set;
// absence of a log nobody enabled is not absence of behaviour.

const DETACHED_REAP_CASES = [
  ['cancel-ack', 'cancelled'],
  ['cancel-no-ack', 'stalled'],
  ['exit-during-cancel', 'cancelled'],
]

test('cancellation paths close stdin and reap their detached process groups', { concurrency: 3 }, async (t) => {
  const settled = await Promise.allSettled(DETACHED_REAP_CASES.map(([scenario, expectedState]) => (
    t.test(`${scenario} closes stdin and reaps the detached process group`, async () => {
    const taskId = `task-${scenario}`
    const live = liveRun(taskId, {
      MOCK_SCENARIO: scenario,
      MOCK_CANCEL_RESPOND: scenario === 'cancel-ack' ? '1' : '0',
      MOCK_SPAWN_DESCENDANT: '1',
      // Widened 2026-07-31 after this family failed under full-suite load and
      // passed 120/120 alone. The windows assert nothing — what this test
      // asserts is that stdin closes, the group is reaped, and the terminal
      // state is the right one. At 35ms of cancel grace, whether the child's
      // exit lands inside the window is decided by the scheduler, and this file
      // now runs its own cases three-wide while twenty other files run beside
      // it. A window narrower than the machine's jitter tests the machine.
      ACP_CANCEL_GRACE_MS: '250',
      ACP_PROCESS_KILL_GRACE_MS: '300',
    }, undefined, 1.5)
    const pid = await waitForDescendantPid(live.cwd, scenario)
    const birthId = processBirthId(pid)
    const r = await live.completion
    assert.equal(r.status, 1, `exit 1 expected; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
    assert.equal(existsSync(join(r.cwd, '.cancel-seen')), true)
    const state = snapshot(r.cwd, taskId)
    assert.equal(state.liveness_state, expectedState)
    assert.deepEqual(state.active_tools, [], `${scenario} terminal snapshot must clear active tools`)
    // The live process first, the words about it second. Held the other way
    // round for a week: on a host with no /proc both descendant sweeps were
    // no-ops, the orphan outlived every cancellation, and the only thing anyone
    // ever saw was a receipt line that did not match a regex. A surviving
    // process must never be reported as a formatting complaint.
    await assertPidGone(pid, scenario, birthId)
    const event = eventTexts(r.cwd)[0]
    // H4: closeAndReapChild computed groupGone and then dropped it from its
    // return value, so a caller could persist a terminal receipt with no way
    // to tell a truly reaped process group from one that outlived every
    // TERM/KILL sweep. assertPidGone just proved the group IS gone by this
    // point, so the receipt must say so in words, not merely by omission.
    assert.match(event, /^descendant_group_gone: true$/m)
    if (expectedState === 'cancelled') {
      assert.match(event, /^child_settlement_signal_delivered: false$/m)
      assert.match(event, /^descendant_cleanup_signal_delivered: true$/m)
    } else {
      assert.match(event, /^child_settlement_signal_delivered: true$/m)
      assert.match(event, /^descendant_cleanup_signal_delivered: false$/m)
    }
    })
  )))
  const failure = settled.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
})

// A grace is a CEILING, not a delay. The child in these three scenarios exits
// 5ms after cancellation and the companion settles the moment it does, so a
// large ceiling costs a quiet machine nothing at all — it is never reached.
//
// It was 80ms, which is below the scheduler's noise floor on a busy machine, and
// these three tests state "the child exited BEFORE the grace" as their PREMISE:
// it is in two of their names. When the machine inverted that premise the test
// measured the forced path instead and reported the difference as a value
// mismatch, which reads exactly like a code regression. Reproduced deliberately
// on 2026-08-03 at load 60 (two copies of this file plus ten spinners):
// `liveness_state` came back `stalled` where the test names `cancelled`. That is
// the whole of the "load fragility" this file was carrying as an open,
// unexplained item — it was never a flake and never a helper timeout.
//
// The tests below that WANT the grace to expire set their own small value and
// are left alone: their mock never voluntarily settles the ACP protocol
// before the signal arrives, so the 20ms cancellation-grace premise always
// wins and no amount of load can invert it.
//
// That claim used to continue "...so no amount of load can invert them" for
// the whole outcome, which was false. Two of those tests exercise the forced
// SIGTERM path, and forced termination races a SEPARATE 100ms TERM->KILL
// grace (production: acp-companion.mjs's processKillTimer) against the
// companion's own event loop noticing the child settled. Under staged CPU
// pressure that race inverted once for the SIGTERM-handler case: the SIGKILL
// timer fired before the companion had processed the child's own exit(0),
// so the recorded evidence read `child_signal: SIGKILL` where the test names
// `child_signal: none`. The 20ms cancellation grace was never the fragile
// part; the separate 100ms escalation ceiling was. Widened below for the
// same "ceiling, not delay" reason as CLEAN_EXIT_CANCEL_GRACE_MS: both mocks
// settle within single-digit milliseconds of receiving the signal on any
// machine, so a 5000ms ceiling costs a quiet run nothing and is never reached.
const FORCED_TERM_KILL_GRACE_MS = '5000'
const CLEAN_EXIT_CANCEL_GRACE_MS = '5000'

concurrentTest('clean child exit 0 before cancellation grace is cancelled, not forced', async () => {
  const taskId = 'task-cancel-clean-exit'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'cancel-clean-exit',
    MOCK_EXIT_DELAY_MS: '5',
    ACP_CANCEL_GRACE_MS: CLEAN_EXIT_CANCEL_GRACE_MS,
    ACP_PROCESS_KILL_GRACE_MS: '100',
  }, undefined, 0.5)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, taskId)
  assert.equal(state.liveness_state, 'cancelled')
  assert.deepEqual(state.active_tools, [])
  const event = eventTexts(r.cwd)[0]
  assert.match(event, /^terminal: cancelled$/m)
  assert.match(event, /^child_exit_code: 0$/m)
  assert.match(event, /^child_signal: none$/m)
  assert.match(event, /^termination_delivered: false$/m)
  assert.match(event, /^child_settlement_signal_delivered: false$/m)
  assert.match(event, /^descendant_cleanup_signal_delivered: false$/m)
  assert.match(event, /^forced_reap_delivered: false$/m)
})

concurrentTest('nonzero child exit before cancellation grace is failed and preserves its code', async () => {
  const taskId = 'task-cancel-exit-seven'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'cancel-exit-7',
    MOCK_EXIT_DELAY_MS: '5',
    ACP_CANCEL_GRACE_MS: CLEAN_EXIT_CANCEL_GRACE_MS,
    ACP_PROCESS_KILL_GRACE_MS: '100',
  }, undefined, 0.5)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, taskId)
  assert.equal(state.liveness_state, 'failed')
  assert.equal(state.termination_reason, 'agent_exit')
  assert.deepEqual(state.active_tools, [])
  const event = eventTexts(r.cwd)[0]
  assert.match(event, /^terminal: agent-exit$/m)
  assert.match(event, /^exit_code: 7$/m)
  assert.match(event, /^child_exit_code: 7$/m)
  assert.match(event, /^child_signal: none$/m)
  assert.match(event, /^termination_delivered: false$/m)
  assert.match(event, /^child_settlement_signal_delivered: false$/m)
  assert.match(event, /^descendant_cleanup_signal_delivered: false$/m)
})

concurrentTest('default SIGTERM termination is stalled and records delivered forced provenance', async () => {
  const taskId = 'task-cancel-sigterm'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'cancel-no-ack',
    ACP_CANCEL_GRACE_MS: '20',
    ACP_PROCESS_KILL_GRACE_MS: FORCED_TERM_KILL_GRACE_MS,
  }, undefined, 0.5)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, taskId)
  assert.equal(state.liveness_state, 'stalled')
  assert.deepEqual(state.active_tools, [])
  const event = eventTexts(r.cwd)[0]
  assert.match(event, /^terminal: stalled$/m)
  assert.match(event, /^child_exit_code: none$/m)
  assert.match(event, /^child_signal: SIGTERM$/m)
  assert.match(event, /^termination_delivered: true$/m)
  assert.match(event, /^child_settlement_signal_delivered: true$/m)
  assert.match(event, /^descendant_cleanup_signal_delivered: false$/m)
})

concurrentTest('SIGTERM handler exit 0 remains stalled because the companion delivered the signal', async () => {
  const taskId = 'task-cancel-sigterm-exit-zero'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'cancel-sigterm-exit-zero',
    ACP_CANCEL_GRACE_MS: '20',
    ACP_PROCESS_KILL_GRACE_MS: FORCED_TERM_KILL_GRACE_MS,
  }, undefined, 0.5)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, taskId)
  assert.equal(state.liveness_state, 'stalled')
  assert.deepEqual(state.active_tools, [])
  const event = eventTexts(r.cwd)[0]
  assert.match(event, /^terminal: stalled$/m)
  assert.match(event, /^child_exit_code: 0$/m)
  assert.match(event, /^child_signal: none$/m)
  assert.match(event, /^termination_delivered: true$/m)
  assert.match(event, /^child_settlement_signal_delivered: true$/m)
  assert.match(event, /^descendant_cleanup_signal_delivered: false$/m)
})

// Regression guard for the reproduced TERM->KILL inversion: stands in for
// scheduler contention with a bounded, deterministic handler delay instead of
// staged CPU pressure. 250ms exceeds the OLD 100ms escalation ceiling (would
// have inverted to SIGKILL) but is well inside FORCED_TERM_KILL_GRACE_MS, so
// this only proves something if the widened grace is actually in effect.
concurrentTest('SIGTERM handler that is slow to exit still settles clean under the widened kill grace', async () => {
  const taskId = 'task-cancel-sigterm-slow-exit'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'cancel-sigterm-exit-zero',
    MOCK_SIGTERM_EXIT_DELAY_MS: '250',
    ACP_CANCEL_GRACE_MS: '20',
    ACP_PROCESS_KILL_GRACE_MS: FORCED_TERM_KILL_GRACE_MS,
  }, undefined, 0.5)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, taskId)
  assert.equal(state.liveness_state, 'stalled')
  assert.deepEqual(state.active_tools, [])
  const event = eventTexts(r.cwd)[0]
  assert.match(event, /^terminal: stalled$/m)
  assert.match(event, /^child_exit_code: 0$/m)
  assert.match(event, /^child_signal: none$/m)
  assert.match(event, /^kill_delivered: false$/m)
  assert.match(event, /^termination_delivered: true$/m)
  assert.match(event, /^child_settlement_signal_delivered: true$/m)
  assert.match(event, /^descendant_cleanup_signal_delivered: false$/m)
})

concurrentTest('child-exit race follows observed code when signal delivery loses the race', async () => {
  const taskId = 'task-cancel-race-exit-seven'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'cancel-race-exit-7',
    MOCK_EXIT_DELAY_MS: '0',
    MOCK_RACE_HOLDER_MS: '700',
    ACP_CANCEL_GRACE_MS: '500',
    ACP_PROCESS_KILL_GRACE_MS: '100',
  }, undefined, 0.5)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, taskId)
  assert.equal(state.liveness_state, 'failed')
  assert.equal(state.termination_reason, 'agent_exit')
  const event = eventTexts(r.cwd)[0]
  assert.match(event, /^child_exit_code: 7$/m)
  assert.match(event, /^termination_delivered: false$/m)
  assert.match(event, /^child_settlement_signal_delivered: false$/m)
  assert.match(event, /^descendant_cleanup_signal_delivered: true$/m)
})

concurrentTest('captured settlement facts cannot be rewritten by later mutable bookkeeping', async () => {
  const taskId = 'task-captured-settlement'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'cancel-clean-exit',
    MOCK_EXIT_DELAY_MS: '5',
    ACP_CANCEL_GRACE_MS: CLEAN_EXIT_CANCEL_GRACE_MS,
    ACP_PROCESS_KILL_GRACE_MS: '100',
    ACP_TEST_MUTATE_SETTLEMENT_AFTER_CAPTURE: '1',
  }, undefined, 0.5)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, taskId)
  assert.equal(state.liveness_state, 'cancelled')
  const event = eventTexts(r.cwd)[0]
  assert.match(event, /^cancel_ack: false$/m)
  assert.match(event, /^child_exit_code: 0$/m)
  assert.match(event, /^child_settlement_signal_delivered: false$/m)
  assert.match(event, /^descendant_cleanup_signal_delivered: false$/m)
  assert.match(event, /^termination_delivered: false$/m)
  assert.match(event, /^kill_delivered: false$/m)
  assert.match(event, /^forced_reap_delivered: false$/m)
})

concurrentTest('hard timeout remains failed even when cancellation ACK is received', async () => {
  const taskId = 'task-hard-timeout-ack'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'cancel-no-ack',
    MOCK_CANCEL_RESPOND: '1',
    ACP_HARD_TIMEOUT_SEC: '0.8',
    ACP_CANCEL_GRACE_MS: '20',
    ACP_PROCESS_KILL_GRACE_MS: '50',
  }, undefined, 2)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, taskId)
  assert.equal(state.liveness_state, 'failed')
  assert.equal(state.termination_reason, 'hard_timeout')
  assert.deepEqual(state.active_tools, [])
  const events = eventTexts(r.cwd)
  assert.equal(events.length, 1)
  assert.equal(field(events[0], 'terminal'), 'hard-timeout')
  assert.equal(field(events[0], 'exit_code'), '1')
  assert.equal(field(events[0], 'cancel_ack'), 'true')
  assert.equal(field(events[0], 'timed_out'), 'true')
})

concurrentTest('irreducible terminal v1 snapshot may exceed artificial 1070-byte target but never production cap', async () => {
  const taskId = `t${'x'.repeat(63)}`
  const r = await asyncRun(taskId, {
    ACP_TEST_SNAPSHOT_BUDGET_BYTES: '1070',
  })
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const raw = readFileSync(join(r.cwd, '.tmux-teams', 'liveness', `${taskId}.json`), 'utf8')
  const state = JSON.parse(raw)
  assert.equal(state.task_id, taskId)
  assert.equal(state.liveness_state, 'completed')
  assert.deepEqual(state.active_tools, [])
  const bytes = Buffer.byteLength(raw, 'utf8')
  assert.ok(bytes > 1070, `the valid max-length task envelope should exercise the irreducible path (${bytes})`)
  assert.ok(bytes <= 64 * 1024)
  assert.match(readFileSync(join(r.cwd, '.tmux-teams', 'dispatch', `${taskId}.md`), 'utf8'), /^liveness_state: completed$/m)
})

for (const failureStage of ['write', 'readback']) {
  concurrentTest(`terminal ${failureStage} persistence failure fails closed with explicit evidence`, async () => {
    const taskId = `task-persist-${failureStage}`
    const r = await asyncRun(taskId, { ACP_TEST_TERMINAL_PERSISTENCE_FAILURE: failureStage })
    assert.notEqual(r.status, 0, `persistence failure must not exit 0; stderr:\n${r.stderr}`)
    const state = snapshot(r.cwd, taskId)
    assert.equal(state.liveness_state, 'failed')
    assert.equal(state.termination_reason, 'liveness_persistence_failed')
    assert.deepEqual(state.active_tools, [])
    const dispatch = readFileSync(join(r.cwd, '.tmux-teams', 'dispatch', `${taskId}.md`), 'utf8')
    const event = eventTexts(r.cwd)[0]
    assert.match(dispatch, /^liveness_state: failed$/m)
    assert.match(dispatch, /^termination_reason: liveness_persistence_failed$/m)
    assert.match(dispatch, /^liveness_persistence_failed: true$/m)
    assert.match(event, /^terminal: liveness-persistence-failed$/m)
    assert.match(event, /^termination_reason: liveness_persistence_failed$/m)
    assert.match(event, /^liveness_persistence_failed: true$/m)
  })
}

test('cancellation ordering is ACP session/cancel, grace, then process-group signal', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-cancel-order-'))
  const control = join(cwd, 'control.log')
  const r = run('task-cancel-order', {
    MOCK_SCENARIO: 'cancel-no-ack',
    ACP_CONTROL_LOG: control,
    ACP_CANCEL_GRACE_MS: '35',
    ACP_PROCESS_KILL_GRACE_MS: '100',
  }, cwd, 1)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const controlText = readFileSync(control, 'utf8')
  const cancelIndex = controlText.indexOf('session/cancel')
  const graceIndex = controlText.indexOf('grace')
  const signalIndex = controlText.indexOf('signal SIGTERM')
  assert.ok(cancelIndex >= 0 && graceIndex > cancelIndex && signalIndex > graceIndex, controlText)
})

test('an explicit hard ceiling is cancel-first when a session exists', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-hard-ceiling-'))
  const control = join(cwd, 'control.log')
  const r = run('task-hard-ceiling-cancel-first', {
    MOCK_SCENARIO: 'silent-tool',
    MOCK_TOOL_DELAY_MS: '1000',
    ACP_CONTROL_LOG: control,
    ACP_HARD_TIMEOUT_SEC: '0.12',
    ACP_CANCEL_GRACE_MS: '35',
    ACP_PROCESS_KILL_GRACE_MS: '40',
  }, cwd, 2)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, 'task-hard-ceiling-cancel-first')
  assert.equal(state.liveness_state, 'failed')
  assert.equal(state.termination_reason, 'hard_timeout')
  assert.deepEqual(state.active_tools, [])
  assert.match(eventTexts(r.cwd)[0], /^terminal: hard-timeout$/m)
  const controlText = readFileSync(control, 'utf8')
  assert.ok(controlText.indexOf('session/cancel') < controlText.indexOf('signal SIGTERM'), controlText)
})

test('a startup hard ceiling records ACP cancellation unavailable before signaling', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-hard-startup-'))
  const control = join(cwd, 'control.log')
  const r = run('task-hard-startup', {
    MOCK_SCENARIO: 'startup-stall',
    MOCK_STALL_STAGE: 'initialize',
    ACP_CONTROL_LOG: control,
    ACP_HARD_TIMEOUT_SEC: '0.09',
    ACP_PROCESS_KILL_GRACE_MS: '40',
  }, cwd, 2)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, 'task-hard-startup')
  assert.equal(state.liveness_state, 'failed')
  assert.equal(state.termination_reason, 'hard_timeout')
  assert.deepEqual(state.active_tools, [])
  assert.equal(state.cancellation_unavailable, true)
  const controlText = readFileSync(control, 'utf8')
  assert.ok(controlText.indexOf('session/cancel unavailable') >= 0)
  assert.ok(controlText.indexOf('session/cancel unavailable') < controlText.indexOf('signal SIGTERM'), controlText)
  assert.match(eventTexts(r.cwd)[0], /^terminal: hard-timeout$/m)
})

test('duplicate, session-mismatched, and noise updates do not renew the lease', () => {
  // The stall budget has to outlast process STARTUP, not just the mock's own
  // 22ms delay. At 0.2s this test asserted a progress count of 5 against a run
  // whose whole life was shorter than spawning node and completing the ACP
  // handshake while this file's concurrent cases spawn beside it — and it
  // failed with `actual: 0`, having counted events that never had time to
  // happen. It is green 8/8 alone at load 21 and red inside the file, which is
  // the signature of a budget measuring the harness rather than the behaviour.
  // What the test is about — WHICH updates renew a lease — is unchanged: the
  // mock stops emitting after its script either way, so the run still stalls.
  const r = run('task-noop-noise', {
    MOCK_SCENARIO: 'duplicates-noise',
    MOCK_DUPLICATE_DELAY_MS: '22',
    ACP_CANCEL_GRACE_MS: '250',
    ACP_PROCESS_KILL_GRACE_MS: '300',
  }, undefined, 2)
  assert.equal(r.status, 1, `exit 1 expected; stderr:\n${r.stderr}`)
  const state = snapshot(r.cwd, 'task-noop-noise')
  assert.equal(state.liveness_state, 'stalled')
  assert.deepEqual(state.active_tools, [])
  assert.equal(state.meaningful_progress_count, 5, 'initialize/new responses plus one message, one tool lifecycle change, and the turn response count as progress')
  assert.equal(state.tools['duplicate-tool'].update_count, 1)
  assert.ok(state.last_protocol_activity_at)
  assert.match(eventTexts(r.cwd)[0], /^termination_reason: stall_confirmed$/m)
})

concurrentTest('long streams keep liveness state bounded and redact tool/output secrets', async () => {
  const r = await asyncRun('task-long-stream', {
    MOCK_SCENARIO: 'long-stream',
    MOCK_LONG_STREAM_COUNT: '500',
    MOCK_SPAWN_DESCENDANT: '1',
    ACP_LIVENESS_TICK_MS: '5',
    ACP_LIVENESS_WRITE_INTERVAL_MS: '20',
    ACP_PROCESS_REAP_GRACE_MS: '600',
  }, undefined, 1)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const raw = readFileSync(join(r.cwd, '.tmux-teams', 'liveness', 'task-long-stream.json'), 'utf8')
  const state = JSON.parse(raw)
  assertV1Semantics(state, { expectedState: 'completed', expectCancellationUnavailable: false })
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 64 * 1024, `liveness snapshot grew to ${Buffer.byteLength(raw, 'utf8')} bytes`)
  assert.ok(!raw.includes('sk-test-secret-12345678901234567890'))
  assert.ok(!raw.includes('SUPER_SECRET_VALUE'))
  assert.ok(Object.keys(state.tools).length <= 64)
  assert.ok(state.stall_history.length <= 32)
  assert.ok(state.active_tools.length <= 8)
  await assertPidGone(descendantPid(r.cwd), 'long-stream completion')
})

concurrentTest('Unicode-heavy terminal snapshots compact under the UTF-8 cap and never retain raw tool data', async () => {
  const taskId = 'task-unicode-large-tools'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'unicode-large-tools',
    MOCK_UNICODE_TOOL_COUNT: '96',
    MOCK_SPAWN_DESCENDANT: '1',
    ACP_LIVENESS_TICK_MS: '5',
    ACP_LIVENESS_WRITE_INTERVAL_MS: '5',
    ACP_PROCESS_REAP_GRACE_MS: '600',
  }, undefined, 1)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const livePath = join(r.cwd, '.tmux-teams', 'liveness', `${taskId}.json`)
  const raw = readFileSync(livePath, 'utf8')
  const state = JSON.parse(raw)
  assert.equal(state.liveness_state, 'completed')
  assertV1Semantics(state, { expectedState: 'completed', expectCancellationUnavailable: false })
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 64 * 1024)
  assert.deepEqual(state.active_tools, [])
  assert.ok(Object.values(state.tools).some((tool) => tool.status === 'in_progress'), 'terminal tools retain last ACP-reported status')
  assert.ok(Object.keys(state.tools).length < 64, 'Unicode stress must exercise deterministic tool compaction')
  assert.ok(Object.keys(state.tools).length <= 64)
  assert.ok(state.active_tools.length <= 8)
  assert.ok(state.active_tools.every((tool) => state.tools[tool.tool_call_id]))
  assert.ok(!raw.includes('sk-unicode-secret-12345678901234567890'))
  assert.ok(!raw.includes('password='))
  assert.ok(!raw.includes('apiKey='))
  assert.ok(!raw.includes('内容'))
  assert.ok(!raw.includes('出力'))
  assert.ok(!raw.includes('場所'))
  const artifacts = persistedArtifacts(r.cwd, taskId)
  assert.match(artifacts[1], /^active_tools: \[\]$/m, 'terminal dispatch current-active field must be empty')
  assert.match(artifacts[2], /^active_tools: \[\]$/m, 'terminal KMS current-active field must be empty')
  const livenessDir = join(r.cwd, '.tmux-teams', 'liveness')
  assert.deepEqual(readdirSync(livenessDir).filter((name) => name.endsWith('.tmp')), [])
  await assertPidGone(descendantPid(r.cwd), 'Unicode-heavy completion')
})

concurrentTest('minimal terminal fallback preserves v1 shape and clears current active tools', async () => {
  const taskId = 'task-minimal-terminal-fallback'
  const r = await asyncRun(taskId, {
    MOCK_SCENARIO: 'unicode-large-tools',
    MOCK_UNICODE_TOOL_COUNT: '65',
    MOCK_MODEL: 'gpt-5.6-luna',
    MOCK_REASONING_EFFORT: 'ultra',
    ACP_EXPECT_MODEL: 'gpt-5.6-luna',
    ACP_EXPECT_REASONING_EFFORT: 'ultra',
    ACP_TEST_SNAPSHOT_BUDGET_BYTES: '1070',
    ACP_LIVENESS_TICK_MS: '5',
    ACP_LIVENESS_WRITE_INTERVAL_MS: '5',
    ACP_PROCESS_REAP_GRACE_MS: '600',
  }, undefined, 1)
  assert.equal(r.status, 0, `exit 0 expected; stderr:\n${r.stderr}`)
  const livePath = join(r.cwd, '.tmux-teams', 'liveness', `${taskId}.json`)
  const raw = readFileSync(livePath, 'utf8')
  const state = JSON.parse(raw)
  assertV1Semantics(state, { expectedState: 'completed', expectCancellationUnavailable: false })
  assert.deepEqual(state.active_tools, [])
  assert.equal(state.requested_model, null, 'minimal fallback may omit optional identity metadata')
  assert.equal(state.effective_identity, null)
  assert.equal(state.identity_status, 'unverified')
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 64 * 1024)
  assert.deepEqual(readdirSync(join(r.cwd, '.tmux-teams', 'liveness')).filter((name) => name.endsWith('.tmp')), [])
  await assertPidGone(descendantPid(r.cwd), 'minimal fallback completion')
})

test('concurrent readers never observe partial liveness or dispatch JSON/text', async () => {
  const taskId = 'task-atomic-readers'
  const cwd = mkdtempSync(join(tmpdir(), 'acp-companion-atomic-'))
  const pending = asyncRun(taskId, {
    MOCK_SCENARIO: 'long-stream',
    MOCK_LONG_STREAM_COUNT: '240',
    MOCK_LONG_STREAM_DELAY_MS: '2',
    ACP_LIVENESS_WRITE_INTERVAL_MS: '5',
  }, cwd, 1)
  const failures = []
  const deadline = Date.now() + 1200
  while (Date.now() < deadline) {
    const live = join(cwd, '.tmux-teams', 'liveness', `${taskId}.json`)
    const dispatch = join(cwd, '.tmux-teams', 'dispatch', `${taskId}.md`)
    if (existsSync(live)) {
      try { JSON.parse(readFileSync(live, 'utf8')) } catch (error) { failures.push(`liveness: ${error.message}`) }
    }
    if (existsSync(dispatch)) {
      const text = readFileSync(dispatch, 'utf8')
      if (!/^task_id: task-atomic-readers$/m.test(text)) failures.push('dispatch: missing complete task_id')
      if (!text.endsWith('\n')) failures.push('dispatch: missing final newline')
    }
    for (const directory of [join(cwd, '.tmux-teams', 'receipts'), join(cwd, '.tmux-teams', 'receipt-commits')]) {
      if (!existsSync(directory)) continue
      for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
        try { JSON.parse(readFileSync(join(directory, name), 'utf8')) } catch (error) { failures.push(`${directory}: ${error.message}`) }
      }
    }
    if ((await Promise.race([pending.then(() => true), sleep(2).then(() => false)]))) break
  }
  const result = await pending
  assert.equal(result.status, 0, `exit 0 expected; stderr:\n${result.stderr}`)
  assert.deepEqual(failures, [])
  JSON.parse(readFileSync(join(cwd, '.tmux-teams', 'liveness', `${taskId}.json`), 'utf8'))
})

test('independent companion cases', { concurrency: 4 }, async (t) => {
  const settled = await Promise.allSettled(CONCURRENT_TEST_CASES.map(({ name, fn }) => t.test(name, fn)))
  const failure = settled.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
})
