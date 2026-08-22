// acp-companion.mjs — ACP transport lane for the tmux-teams mailbox contract.
//
// The positional duration is an inactivity/stall lease. It is deliberately
// not a total task timeout: ACP_HARD_TIMEOUT_SEC is the only wall-clock ceiling.
// Liveness is written as bounded, atomic metadata so Pulse and other readers
// never need to parse a partially-written snapshot or retain agent content.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
// ข้อ 13: this process is a sanctioned ledger writer, so it appends through the
// same gate the runner does rather than keeping a private copy of the policy.
import { appendEvent } from './ledger-writer.mjs'

const [agentName, cwd, taskId, briefFile, leaseArg] = process.argv.slice(2)
if (!agentName || !cwd || !taskId || !briefFile) {
  console.error('usage: node acp-companion.mjs <claude|codex|agy> <cwd> <task-id> <brief-file> [stall-sec]')
  process.exit(2)
}

const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
const SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
if (!ID_RE.test(taskId)) {
  console.error(`invalid task id "${taskId}" — 1-64 chars, alphanumeric/_/-, starts alphanumeric or _`)
  process.exit(2)
}

const rawAgentId = process.env.ACP_AGENT_ID
if (rawAgentId !== undefined && !ID_RE.test(rawAgentId)) {
  console.error(`invalid ACP_AGENT_ID "${rawAgentId}" — 1-64 chars, alphanumeric/_/-, starts alphanumeric or _`)
  process.exit(2)
}
const agentId = rawAgentId ?? ''

// The dispatcher's proof that a later-read liveness record is the one THIS
// spawn produced, not a predecessor's or a forgery stamped inside its
// timestamp window (`acp-dispatch.mjs`'s `belongsToThisRun`). Optional here:
// `loop-runner.mjs` starts companions directly and never checks this field, so
// a lane it starts simply carries none.
const rawSpawnNonce = process.env.ACP_SPAWN_NONCE
if (rawSpawnNonce !== undefined && !ID_RE.test(rawSpawnNonce)) {
  console.error(`invalid ACP_SPAWN_NONCE "${rawSpawnNonce}" — 1-64 chars, alphanumeric/_/-, starts alphanumeric or _`)
  process.exit(2)
}
const spawnNonce = rawSpawnNonce ?? ''

if (agentName.trim().toLowerCase() === 'gemini') {
  console.error(`unsupported agent "${agentName}" — use claude|codex|agy or another name with ACP_CMD`)
  process.exit(2)
}

const CODEX_INITIAL_AGENT_MODES = new Set(['read-only', 'agent', 'agent-full-access'])
const explicitInitialAgentMode = process.env.INITIAL_AGENT_MODE
if (agentName === 'codex' && explicitInitialAgentMode !== undefined
  && !CODEX_INITIAL_AGENT_MODES.has(explicitInitialAgentMode)) {
  console.error('invalid INITIAL_AGENT_MODE — Codex ACP accepts read-only|agent|agent-full-access')
  process.exit(2)
}
const effectiveInitialAgentMode = agentName === 'codex'
  ? explicitInitialAgentMode ?? 'agent-full-access'
  : explicitInitialAgentMode

// The ACP terminal capability, gated by explicit opt-in and off by default.
// RULE: a dispatched review lane must never gain a terminal — the review
// gate's whole contract is zero built-in tools, no MCP servers, every
// permission denied, and a terminal is a bigger hole than any of those. So
// this is never inferred from agentName or from anything the adapter says;
// it is only ever true when an operator sets it, for a person-attended login
// run where the adapter's own Claude Subscription / Console auth flow needs
// somewhere to print a URL or code and read back what a human typed. No
// caller in this repo (acp-dispatch.mjs, loop-runner.mjs, review-gate.mjs)
// may ever set this for ordinary dispatch or review.
const terminalCapabilityEnv = process.env.ACP_ENABLE_TERMINAL
if (terminalCapabilityEnv !== undefined && terminalCapabilityEnv !== '0' && terminalCapabilityEnv !== '1') {
  console.error('invalid ACP_ENABLE_TERMINAL — use 0 or 1')
  process.exit(2)
}
const terminalCapabilityEnabled = terminalCapabilityEnv === '1'

const receiptRequiredEnv = process.env.ACP_SESSION_RECEIPT_REQUIRED
if (receiptRequiredEnv !== undefined && receiptRequiredEnv !== '0' && receiptRequiredEnv !== '1') {
  console.error('invalid ACP_SESSION_RECEIPT_REQUIRED — use 0 or 1')
  process.exit(2)
}
const receiptRequired = receiptRequiredEnv === '1'
const receiptFailureInjected = new Set()
const requestedOperationEnv = process.env.ACP_SESSION_OPERATION
if (requestedOperationEnv !== undefined && !['new', 'load'].includes(requestedOperationEnv)) {
  console.error('invalid ACP_SESSION_OPERATION — use new|load')
  process.exit(2)
}
const explicitResumeId = process.env.ACP_RESUME?.trim() ?? ''
const priorDispatchIdEnv = process.env.ACP_PRIOR_DISPATCH_ID?.trim() ?? ''
const priorReceiptDigestEnv = process.env.ACP_PRIOR_RECEIPT_DIGEST?.trim() ?? ''
if (receiptRequired) {
  if (!requestedOperationEnv) {
    console.error('ACP_SESSION_RECEIPT_REQUIRED=1 requires explicit ACP_SESSION_OPERATION=new|load')
    process.exit(2)
  }
  if (requestedOperationEnv === 'new') {
    if (explicitResumeId || priorDispatchIdEnv || priorReceiptDigestEnv) {
      console.error('a required new operation cannot carry resume or prior-receipt inputs')
      process.exit(2)
    }
  } else {
    if (!SESSION_ID_RE.test(explicitResumeId)) {
      console.error('required ACP session/load needs a safe ACP_RESUME session id')
      process.exit(2)
    }
    if (!ID_RE.test(priorDispatchIdEnv)) {
      console.error('required ACP session/load needs a safe ACP_PRIOR_DISPATCH_ID')
      process.exit(2)
    }
    if (!DIGEST_RE.test(priorReceiptDigestEnv)) {
      console.error('required ACP session/load needs an ACP_PRIOR_RECEIPT_DIGEST sha256 digest')
      process.exit(2)
    }
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function strictNonNegativeEnvNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const number = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(number) || number < 0) {
    console.error(`invalid ${name} — use a finite non-negative number of milliseconds`)
    process.exit(2)
  }
  return number
}

// Compatibility contract: leaseArg is still the fifth positional argument,
// but it now governs inactivity windows only.
const stallSec = positiveNumber(leaseArg, 600)
const stallMs = stallSec * 1000
const hardTimeoutSec = nonNegativeNumber(process.env.ACP_HARD_TIMEOUT_SEC)
const hardTimeoutMs = hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0
const stallPolicy = process.env.ACP_STALL_POLICY?.trim().toLowerCase() === 'report' ? 'report' : 'cancel'
const cancelGraceSec = nonNegativeNumber(process.env.ACP_CANCEL_GRACE_SEC, 5)
const cancelGraceMs = process.env.ACP_CANCEL_GRACE_MS === undefined
  ? cancelGraceSec * 1000
  : nonNegativeNumber(process.env.ACP_CANCEL_GRACE_MS, cancelGraceSec * 1000)
const processKillGraceMs = process.env.ACP_PROCESS_KILL_GRACE_MS === undefined
  ? 5000
  : nonNegativeNumber(process.env.ACP_PROCESS_KILL_GRACE_MS, 5000)
// Separate orderly-close and final process-group observation waits from the
// SIGTERM→SIGKILL grace above. Production keeps the historical 1000 ms floor;
// hermetic tests may shorten both reap waits explicitly.
const processReapGraceMs = strictNonNegativeEnvNumber('ACP_PROCESS_REAP_GRACE_MS', 1000)
// A terminal child gets its own grace rather than reusing processKillGraceMs
// directly: it is a separate ladder (see killAllLiveTerminals) with no
// process-group tracking of its own, and a test that needs a fast SIGKILL
// escalation for a SIGTERM-trapping terminal must not also shorten the main
// agent child's unrelated grace.
const terminalKillGraceMs = strictNonNegativeEnvNumber('ACP_TERMINAL_KILL_GRACE_MS', processKillGraceMs)
// A terminal child's `exit` can fire before its stdout/stderr pipes are fully
// drained — Node's own docs say plainly that data may still be buffered at
// that point — so finalizing the terminal record (ending both decoders,
// releasing every `terminal/wait_for_exit` waiter) waits for `close` instead,
// which fires only once those streams have actually finished. A launcher
// command (a shell, npx, bunx, anything that forks) can leave a descendant
// holding the same pipe open past the wrapper's own exit, and if that
// descendant never lets go, `close` would never fire on its own — this bounds
// that wait so a misbehaving terminal cannot hang `wait_for_exit` for the
// rest of the turn. A dedicated grace rather than reusing processReapGraceMs
// or terminalKillGraceMs: it bounds a different wait (stream finalization,
// not process-group liveness or a kill escalation) and a hermetic test must
// be able to shorten it without also shortening those.
const terminalCloseGraceMs = strictNonNegativeEnvNumber('ACP_TERMINAL_CLOSE_GRACE_MS', 2000)
const livenessTickMs = positiveNumber(
  process.env.ACP_LIVENESS_TICK_MS,
  Math.max(10, Math.min(1000, stallMs / 4)),
)
const persistenceIntervalMs = positiveNumber(process.env.ACP_LIVENESS_WRITE_INTERVAL_MS, 50)

// The phase subsystem is gone, and with it the controller that issued these
// reservations. What must NOT go quietly is a repository that was governed by
// it: an install still carrying the marker was one where a raw companion
// invocation could not run without the controller's exact reservation, and
// silently downgrading it to ungoverned on upgrade is the one behaviour change
// nobody would see. This refuses instead, and says what to do about it.
const LEGACY_PHASE_GATE_MARKER = join(cwd, '.tmux-teams', 'phase-gate.json')
const LEGACY_GATE_ENV = [
  'TMUX_TEAMS_PHASE_GATE', 'TMUX_TEAMS_GATE_STORE', 'TMUX_TEAMS_GATE_DISPATCH_UUID',
  'TMUX_TEAMS_GATE_RESERVATION_EVENT_ID', 'TMUX_TEAMS_GATE_PHASE', 'TMUX_TEAMS_GATE_TASK_ID',
  'TMUX_TEAMS_GATE_AGENT_ID', 'TMUX_TEAMS_GATE_BRIEF_DIGEST', 'TMUX_TEAMS_GATE_TIMEOUT_SEC',
]
if (existsSync(LEGACY_PHASE_GATE_MARKER)) {
  console.error('[phase-gate] PHASE_GATE_RETIRED: this repository still carries'
    + ` ${LEGACY_PHASE_GATE_MARKER}, written by the phase-gate controller, which no longer exists.`
    + ' Retire it deliberately — archive the marker and .tmux-teams/phase-gate-store, then remove'
    + ' the marker — rather than letting an upgrade turn a governed repository into an ungoverned one.')
  process.exit(2)
}
const strayGateEnv = LEGACY_GATE_ENV.filter((name) => process.env[name] !== undefined)
if (strayGateEnv.length > 0) {
  console.error(`[phase-gate] PHASE_GATE_RETIRED: ${strayGateEnv.join(', ')} names a gate that no`
    + ' longer exists. Unset it; nothing here reads it, and leaving it set means a caller believes'
    + ' in an authorization step that is not happening.')
  process.exit(2)
}

// The last word of the four-stage system, and it outlived the system by a
// release. v0.14.0 deleted the phases; this variable kept checking a name
// against `Requirement|Prototype|Development|QA` and refusing anything else —
// so an operator driving a companion by hand for a team called `control` or
// `review` was told to use a vocabulary describing nothing that still exists.
//
// Nothing in this repository ever set it: not the runner, not a script, not a
// skill. It had no producer, its successor map (`PHASE_BOUNDARIES`) had no
// reader beyond its own key list, and what replaced the concept — teams and
// routes — is on every board already.
//
// Retired the way the gate above it was retired, and for the same reason:
// accepting any string instead would write a label pulse discards as
// `unassigned`, which is a declaration that says nothing. Refusing says what
// happened. Footprints already on disk keep their `phase:` line and pulse still
// reads them; nothing new writes one.
if (process.env.TMUX_TEAMS_PHASE !== undefined) {
  console.error('[phase] PHASE_RETIRED: TMUX_TEAMS_PHASE names the four-stage delivery phase system,'
    + ' which was removed in v0.14.0. Nothing reads it. Unset it — a token\'s place is its team and'
    + ' its route, which the board and the ledger already carry.')
  process.exit(2)
}

// Which workflow this dispatch is running is NOT derivable from the declared
// graph: one team serves many workflows, so the caller has to say. Team and
// role stay in the graph (single source of truth); only the route is recorded.
const GRAPH_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const deliveryWorkflow = process.env.TMUX_TEAMS_WORKFLOW?.trim() || ''
if (deliveryWorkflow && !GRAPH_ID_RE.test(deliveryWorkflow)) {
  console.error(`invalid TMUX_TEAMS_WORKFLOW "${deliveryWorkflow}" — 1-128 chars, alphanumeric/_/-/./:`)
  process.exit(2)
}

// The work item is a token that travels with the work. One dispatch is one leg
// of its journey: the token is what makes the leg before and the leg after the
// same piece of work, and its custody ledger is what a board reads to know
// where that work actually is now.
const workItem = process.env.TMUX_TEAMS_WORK_ITEM?.trim() || ''
if (workItem && !GRAPH_ID_RE.test(workItem)) {
  console.error(`invalid TMUX_TEAMS_WORK_ITEM "${workItem}" — 1-128 chars, alphanumeric/_/-/./:`)
  process.exit(2)
}

let brief
try {
  brief = readFileSync(briefFile, 'utf8')
} catch (cause) {
  console.error(`[fatal] cannot read brief: ${cause.message}`)
  process.exit(2)
}

const dispatchId = randomUUID()
const startedMs = Date.now()
const startedAt = new Date(startedMs).toISOString()
const KMS = fileURLToPath(new URL('./kms.mjs', import.meta.url))
const livenessPath = join(cwd, '.tmux-teams', 'liveness', `${taskId}.json`)
const dispatchPath = join(cwd, '.tmux-teams', 'dispatch', `${taskId}.md`)
const workItemsDir = join(cwd, '.tmux-teams', 'work-items')
const sessionsDir = join(cwd, '.tmux-teams', 'sessions')
const sessionFile = join(sessionsDir, taskId)
const receiptsDir = join(cwd, '.tmux-teams', 'receipts')
const receiptPath = join(receiptsDir, `${dispatchId}.json`)
const receiptCommitsDir = join(cwd, '.tmux-teams', 'receipt-commits')
const receiptCommitPath = join(receiptCommitsDir, `${dispatchId}.json`)
const receiptFailuresDir = join(cwd, '.tmux-teams', 'receipt-failures')
const receiptFailurePath = join(receiptFailuresDir, `${dispatchId}.json`)
const controllerSignalsDir = join(cwd, '.tmux-teams', 'controller-signals')
const controllerSignalPath = join(controllerSignalsDir, `${dispatchId}.json`)
const sha256Bytes = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const sha256Text = (value) => sha256Bytes(Buffer.from(String(value), 'utf8'))
let kmsRecorded = false
let receiptDigest = null
let receiptRecord = null
let adapterProfile = null
let priorReceipt = null
let operationContext = {
  requestedOperation: requestedOperationEnv ?? 'new',
  requestedResumeSessionId: explicitResumeId || null,
  operationTrace: null,
  initializeTrace: null,
}

// Whole extra `appendEvent` calls, each of which waits out the ledger lock on
// its own before giving up. Two is a bound, not a spin: past it the holder is
// not slow, it is wedged, and a louder refusal is more use than a longer wait.
const LOCKED_APPEND_RETRIES = 2
const MAX_TEXT = 256
const MAX_DISPLAY_TEXT = 2048
const MAX_STDERR = 64 * 1024
const MAX_SNAPSHOT_BYTES = 64 * 1024
// Tests may lower the budget to exercise the fallback; no caller can raise
// the closed v1 production ceiling above 64 KiB.
const configuredTestSnapshotBudget = Number(process.env.ACP_TEST_SNAPSHOT_BUDGET_BYTES)
const snapshotByteBudget = Number.isFinite(configuredTestSnapshotBudget) && configuredTestSnapshotBudget > 0
  ? Math.min(MAX_SNAPSHOT_BYTES, configuredTestSnapshotBudget)
  : MAX_SNAPSHOT_BYTES
const MAX_WORKER = 64
const MAX_DISPATCH_ID = 64
const MAX_SPAWN_NONCE = 64
const MAX_SESSION_ID = 128
const MAX_MODEL = 128
const MAX_REASONING_EFFORT = 64
const MAX_TERMINATION_REASON = 64
// A worker report, not a payload. The largest real outbox measured on this repo
// is a 42 KiB cross-vendor round-table; 4 MiB leaves that two orders of room and
// still refuses a file nothing here should be reading into memory at once.
const MAX_OUTBOX_BYTES = 4 * 1024 * 1024
// A `terminal/create` request may ask for any outputByteLimit; this is the
// ceiling regardless of what is requested, so a misbehaving or hostile agent
// cannot make the companion retain unbounded output in memory. The default
// (no outputByteLimit in the request) is smaller still — a login command's
// real output is a URL and a short code, not a build log.
const MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_TERMINAL_OUTPUT_BYTES = 64 * 1024
const MAX_ERROR_TEXT = 512
const MAX_TOOL_CALL_ID = 128
const MAX_TOOL_TITLE = 128
const MAX_TOOL_KIND = 64
const MAX_STALL_EVIDENCE = 128
const MAX_PUBLIC_TOOL_RECORDS = 64
const MAX_INTERNAL_TOOL_RECORDS = 256
const MAX_ACTIVE_TOOLS = 64
const MAX_ACTIVE_TOOL_EVIDENCE = 8
const MAX_STALL_HISTORY_ACTIVE_TOOLS = 1
const MAX_STALL_HISTORY = 32
const MAX_FINGERPRINTS = 256
const MAX_PLAN_ENTRIES = 32
const MAX_DIGEST_INPUT = 16 * 1024
const MAX_TOOL_UPDATE_COUNT = 1_000_000
const MAX_RECEIPT_BYTES = 32 * 1024
const MAX_RECEIPT_TEXT = 256
const MAX_PROFILE_BYTES = 64 * 1024
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024
const CODEX_ADAPTER_PACKAGE_SPEC = '@agentclientprotocol/codex-acp@1.1.7'
const CODEX_ADAPTER_RESOLVED_VERSION = '1.1.7'
const CODEX_ADAPTER_INTEGRITY = 'sha512-bhFLbGtOMEw6+PAp33vNERb6dXlULOfV3mWbRdps4v7sY7PHha/C2T1dnlG0yVcvBu9W+NYPzL0CAupnVoFTiQ=='
const CODEX_ADAPTER_ENTRY_DIGEST = 'sha256:0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a'
const CODEX_ADAPTER_METADATA_DIGEST = 'sha256:bf44bf3dfdd5f4e5b9830b15e3a01f096bda6d08514c5b3e3129d7df640c4cf7'
const RECEIPT_COMMIT_SCHEMA = 'acp-session-receipt-commit'
const RECEIPT_COMMIT_SCHEMA_VERSION = 'acp-session-receipt-commit.v1'
const RECEIPT_COMMIT_STATES = new Set(['committed'])
const VALID_TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed'])
const VALID_TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed'])
const VALID_STALL_HISTORY_STATES = new Set(['suspected_stalled', 'stalled', 'recovered', 'cancellation_unavailable'])

const SECRET_PATTERNS = [
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, '$1-<redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{12,}/g, 'gh<redacted>'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, 'github_pat_<redacted>'],
  [/\bxox[baprse]-[A-Za-z0-9-]{10,}/g, 'xox<redacted>'],
  [/\bAKIA[0-9A-Z]{12,}/g, 'AKIA<redacted>'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<redacted-jwt>'],
  [/(?:authorization|proxy-authorization)[ \t]*[:=][ \t]*\S+/gi, 'authorization: <redacted>'],
  [/\bBearer[ \t]+[A-Za-z0-9+/=._-]{12,}/gi, 'Bearer <redacted>'],
  [/(^|[^A-Za-z0-9_])((?:[A-Za-z0-9]{1,32}[_.-]){0,4}(?:api[_.-]?key|token|secret|password|passwd|pwd|credential)s?)([ \t]*[:=][ \t]*)[^\s',;}&]{8,}/gim, '$1$2$3<redacted>'],
  [/(^|[^A-Za-z0-9_])([a-z][A-Za-z0-9]{0,48}(?:Key|Token|Secret|Password|Passwd|Pwd|Credentials?))([ \t]*[:=][ \t]*)[^\s',;}&]{8,}/gm, '$1$2$3<redacted>'],
]

function redact(value) {
  let text = String(value ?? '')
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  return text
}

function boundedText(value, fallback = '', limit = MAX_TEXT) {
  const text = redact(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (text) return text.slice(0, limit)
  return redact(fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit)
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function persistedTimestamp(value, fallback = iso(Date.now())) {
  const text = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)
    ? text
    : fallback
}

function persistedSessionId(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  return boundedText(value, '<redacted-session>', MAX_SESSION_ID)
}

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

const RECEIPT_SCHEMA = 'acp-session-receipt'
const RECEIPT_SCHEMA_VERSION = 'acp-session-receipt.v1'
const RECEIPT_KEYS = [
  'schema', 'schema_version', 'task_id', 'dispatch_id', 'agent_id', 'worker', 'transport',
  'requested_operation', 'performed_operation', 'operation_outcome',
  'requested_resume_session_id', 'effective_session_id', 'prior_dispatch_id', 'prior_receipt_digest',
  'operation_witness', 'operation_request_digest', 'operation_response_digest', 'operation_rpc_id',
  'operation_acknowledged_at', 'requested_model', 'requested_reasoning_effort',
  'effective_identity', 'identity_status', 'adapter_package_spec', 'adapter_resolved_version',
  'adapter_integrity', 'adapter_metadata_digest', 'adapter_entry_digest', 'initialize_agent_info',
  'execution_profile_digest', 'initial_agent_mode', 'codex_executable_identity', 'node_executable_identity', 'resume_status',
]
const RECEIPT_IDENTITY_STATUSES = new Set(['unverified', 'matched', 'missing', 'mismatched'])
const RECEIPT_OUTCOMES = new Set(['succeeded', 'unsupported_fallback', 'failed', 'interrupted'])
const RECEIPT_WITNESSES = new Set(['new_session_id_returned', 'load_response_for_exact_request', 'none'])
const RECEIPT_RESUME_STATUSES = new Set(['not_requested', 'loaded', 'unsupported_fallback', 'load_failed'])

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function receiptTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
}

function boundedReceiptText(value, fallback = '', limit = MAX_RECEIPT_TEXT) {
  const text = boundedText(value, fallback, limit)
  return text.replace(/(^|[^A-Za-z0-9_@])\/(?:[^\s,;)}\]]+)/g, '$1<path-redacted>')
}

function validateReceiptValue(value) {
  if (!exactKeys(value, RECEIPT_KEYS)) throw new Error('receipt has an unexpected field set')
  if (value.schema !== RECEIPT_SCHEMA || value.schema_version !== RECEIPT_SCHEMA_VERSION) {
    throw new Error('receipt schema/version is invalid')
  }
  if (!ID_RE.test(value.task_id) || !ID_RE.test(value.dispatch_id)) throw new Error('receipt task/dispatch id is unsafe')
  if (value.agent_id !== null && !ID_RE.test(value.agent_id)) throw new Error('receipt agent id is unsafe')
  if (typeof value.worker !== 'string' || value.worker.length > MAX_WORKER || !value.worker) throw new Error('receipt worker is invalid')
  if (value.transport !== 'acp') throw new Error('receipt transport is invalid')
  if (!['new', 'load'].includes(value.requested_operation)) throw new Error('receipt requested operation is invalid')
  if (value.performed_operation !== null && !['new', 'load'].includes(value.performed_operation)) throw new Error('receipt performed operation is invalid')
  if (!RECEIPT_OUTCOMES.has(value.operation_outcome)) throw new Error('receipt operation outcome is invalid')
  for (const key of ['requested_resume_session_id', 'effective_session_id']) {
    if (value[key] !== null && (!SESSION_ID_RE.test(value[key]) || value[key].length > MAX_SESSION_ID)) {
      throw new Error(`receipt ${key} is unsafe`)
    }
  }
  if (value.prior_dispatch_id !== null && !ID_RE.test(value.prior_dispatch_id)) throw new Error('receipt prior dispatch id is unsafe')
  for (const key of ['prior_receipt_digest', 'operation_request_digest', 'operation_response_digest', 'adapter_entry_digest', 'execution_profile_digest']) {
    if (value[key] !== null && !DIGEST_RE.test(value[key])) throw new Error(`receipt ${key} is not a sha256 digest`)
  }
  if (!RECEIPT_WITNESSES.has(value.operation_witness)) throw new Error('receipt operation witness is invalid')
  if (value.operation_rpc_id !== null && (!Number.isSafeInteger(value.operation_rpc_id) || value.operation_rpc_id < 1)) {
    throw new Error('receipt JSON-RPC id is invalid')
  }
  if (value.operation_acknowledged_at !== null && !receiptTimestamp(value.operation_acknowledged_at)) {
    throw new Error('receipt acknowledgement time is invalid')
  }
  for (const key of ['requested_model', 'requested_reasoning_effort', 'effective_identity', 'adapter_package_spec', 'adapter_resolved_version']) {
    if (value[key] !== null && (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > MAX_RECEIPT_TEXT)) {
      throw new Error(`receipt ${key} is unbounded or empty`)
    }
  }
  if (value.initial_agent_mode !== null
    && (typeof value.initial_agent_mode !== 'string' || value.initial_agent_mode.length < 1 || value.initial_agent_mode.length > MAX_RECEIPT_TEXT)) {
    throw new Error('receipt initial agent mode is unbounded or empty')
  }
  if (value.adapter_integrity !== null && !/^sha512-[A-Za-z0-9+/=]{16,256}$/.test(value.adapter_integrity)) throw new Error('receipt adapter integrity is invalid')
  if (value.adapter_metadata_digest !== null && !DIGEST_RE.test(value.adapter_metadata_digest)) throw new Error('receipt adapter metadata digest is invalid')
  if (value.initialize_agent_info !== null && (!exactKeys(value.initialize_agent_info, ['name', 'version'])
    || typeof value.initialize_agent_info.name !== 'string' || value.initialize_agent_info.name.length < 1 || value.initialize_agent_info.name.length > MAX_RECEIPT_TEXT
    || typeof value.initialize_agent_info.version !== 'string' || value.initialize_agent_info.version.length < 1 || value.initialize_agent_info.version.length > MAX_RECEIPT_TEXT)) {
    throw new Error('receipt initialize agent info is invalid')
  }
  if (!exactKeys(value.codex_executable_identity, ['name', 'realpath_digest', 'executable_digest', 'version'])
    || typeof value.codex_executable_identity.name !== 'string' || value.codex_executable_identity.name.length < 1 || value.codex_executable_identity.name.length > MAX_RECEIPT_TEXT
    || (value.codex_executable_identity.realpath_digest !== null && !DIGEST_RE.test(value.codex_executable_identity.realpath_digest))
    || (value.codex_executable_identity.executable_digest !== null && !DIGEST_RE.test(value.codex_executable_identity.executable_digest))
    || typeof value.codex_executable_identity.version !== 'string' || value.codex_executable_identity.version.length < 1 || value.codex_executable_identity.version.length > MAX_RECEIPT_TEXT) {
    throw new Error('receipt Codex executable identity is invalid')
  }
  if (!exactKeys(value.node_executable_identity, ['name', 'realpath_digest', 'executable_digest', 'version'])
    || typeof value.node_executable_identity.name !== 'string' || value.node_executable_identity.name.length < 1 || value.node_executable_identity.name.length > MAX_RECEIPT_TEXT
    || (value.node_executable_identity.realpath_digest !== null && !DIGEST_RE.test(value.node_executable_identity.realpath_digest))
    || (value.node_executable_identity.executable_digest !== null && !DIGEST_RE.test(value.node_executable_identity.executable_digest))
    || typeof value.node_executable_identity.version !== 'string' || value.node_executable_identity.version.length < 1 || value.node_executable_identity.version.length > MAX_RECEIPT_TEXT) {
    throw new Error('receipt Node executable identity is invalid')
  }
  if (!RECEIPT_RESUME_STATUSES.has(value.resume_status)) throw new Error('receipt resume status is invalid')
  const acknowledged = value.operation_acknowledged_at !== null
  const correlatedResponse = value.operation_response_digest !== null && value.operation_rpc_id !== null
  if (!acknowledged && correlatedResponse) throw new Error('receipt acknowledgement is missing for a correlated response')
  if (acknowledged && (!correlatedResponse || value.operation_request_digest === null)) {
    throw new Error('receipt acknowledgement lacks its correlated request/response')
  }
  if (value.requested_operation === 'new') {
    if (value.requested_resume_session_id !== null || value.prior_dispatch_id !== null || value.prior_receipt_digest !== null) {
      throw new Error('new receipt carries resume or prior lineage')
    }
    if (value.resume_status !== 'not_requested') throw new Error('new receipt has a resume status')
  } else {
    if (!value.requested_resume_session_id) throw new Error('load receipt lacks requested session')
    if (!value.prior_dispatch_id || !value.prior_receipt_digest) throw new Error('load receipt lacks requested prior lineage')
    if (!['loaded', 'unsupported_fallback', 'load_failed'].includes(value.resume_status)) {
      throw new Error('load receipt has an invalid resume status')
    }
  }
  if (['failed', 'interrupted'].includes(value.operation_outcome)) {
    if (value.performed_operation !== null || value.effective_session_id !== null || value.operation_witness !== 'none') {
      throw new Error('failed receipt carries a session outcome')
    }
    if (value.requested_operation === 'load' && value.resume_status !== 'load_failed') {
      throw new Error('failed load receipt lacks load_failed status')
    }
    if (value.requested_operation === 'new' && value.resume_status !== 'not_requested') {
      throw new Error('failed new receipt has a resume status')
    }
  } else if (value.operation_outcome === 'unsupported_fallback') {
    if (value.requested_operation !== 'load' || value.performed_operation !== 'new'
      || value.effective_session_id === null || value.operation_witness !== 'new_session_id_returned'
      || value.resume_status !== 'unsupported_fallback' || !acknowledged) {
      throw new Error('fallback receipt is not explicit')
    }
  } else if (value.operation_outcome === 'succeeded') {
    if (!acknowledged || value.initialize_agent_info === null || value.performed_operation === null
      || value.effective_session_id === null) throw new Error('successful receipt lacks its operation witness')
    if (value.identity_status === 'missing' || value.identity_status === 'mismatched') {
      throw new Error('successful receipt carries failed identity status')
    }
    if (value.requested_model !== null && (value.identity_status !== 'matched' || value.effective_identity === null)) {
      throw new Error('successful receipt lacks matched requested identity')
    }
    if (value.performed_operation === 'new') {
      if (value.requested_operation !== 'new' || value.operation_witness !== 'new_session_id_returned'
        || value.resume_status !== 'not_requested') throw new Error('new success has an invalid operation matrix')
    } else if (value.performed_operation === 'load') {
      if (value.requested_operation !== 'load' || value.operation_witness !== 'load_response_for_exact_request'
        || value.resume_status !== 'loaded' || value.effective_session_id !== value.requested_resume_session_id) {
        throw new Error('load success has an invalid exact-session matrix')
      }
    }
  } else {
    throw new Error('receipt outcome is not closed')
  }
  return value
}

function serializeReceipt(value) {
  validateReceiptValue(value)
  const raw = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_BYTES) throw new Error('ACP session receipt exceeds its bounded size')
  return raw
}

function fsyncDirectory(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0))
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function readBoundedUtf8(path, maxBytes, label) {
  const bytes = readFileSync(path)
  if (bytes.length > maxBytes) throw new Error(label + ' exceeds its bounded size')
  const raw = bytes.toString('utf8')
  if (!Buffer.from(raw, 'utf8').equals(bytes)) throw new Error(label + ' is not valid UTF-8')
  return { bytes, raw }
}

function readReceiptFile(path, expectedDigest = null) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) throw new Error('receipt target is not a bounded regular file')
  const { bytes, raw } = readBoundedUtf8(path, MAX_RECEIPT_BYTES, 'receipt target')
  const value = JSON.parse(raw)
  validateReceiptValue(value)
  const digest = sha256Bytes(bytes)
  if (expectedDigest && digest !== expectedDigest) throw new Error('receipt digest does not match the requested prior receipt')
  return { raw, value, digest }
}

function receiptCommitValue(dispatch, digest) {
  const value = {
    schema: RECEIPT_COMMIT_SCHEMA,
    schema_version: RECEIPT_COMMIT_SCHEMA_VERSION,
    dispatch_id: dispatch,
    receipt_digest: digest,
    committed_state: 'committed',
  }
  if (!ID_RE.test(value.dispatch_id) || !DIGEST_RE.test(value.receipt_digest) || !RECEIPT_COMMIT_STATES.has(value.committed_state)) {
    throw new Error('receipt commitment envelope is invalid')
  }
  return value
}

function serializeReceiptCommit(value) {
  if (!exactKeys(value, ['schema', 'schema_version', 'dispatch_id', 'receipt_digest', 'committed_state'])
    || value.schema !== RECEIPT_COMMIT_SCHEMA
    || value.schema_version !== RECEIPT_COMMIT_SCHEMA_VERSION
    || !ID_RE.test(value.dispatch_id)
    || !DIGEST_RE.test(value.receipt_digest)
    || !RECEIPT_COMMIT_STATES.has(value.committed_state)) {
    throw new Error('receipt commitment envelope is invalid')
  }
  const raw = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_BYTES) throw new Error('receipt commitment envelope exceeds its bounded size')
  return raw
}

function readReceiptCommitFile(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error('receipt commitment target is not a bounded regular file')
  }
  const { raw } = readBoundedUtf8(path, MAX_RECEIPT_BYTES, 'receipt commitment target')
  const value = JSON.parse(raw)
  serializeReceiptCommit(value)
  return { raw, value }
}

function receiptFailure(stage) {
  const configured = process.env.ACP_TEST_RECEIPT_PERSISTENCE_FAILURE
  const aliases = {
    serialize: ['serialize'],
    schema: ['schema'],
    write: ['write', 'commit'],
    file_fsync: ['file-fsync', 'fsync-file'],
    publish: ['publish', 'link'],
    directory_fsync: ['directory-fsync', 'fsync'],
    readback: ['readback', 'verify'],
    correlation: ['correlation'],
  }
  const direct = process.env[`ACP_TEST_RECEIPT_${stage.toUpperCase()}_FAILURE`] === '1'
  if ((direct || aliases[stage]?.includes(configured)) && !receiptFailureInjected.has(stage)) {
    receiptFailureInjected.add(stage)
    throw Object.assign(new Error(`injected receipt ${stage} failure`), { code: `receipt_${stage}_failure` })
  }
}

function ensureReceiptDirectory() {
  const governedRoot = realpathSync(cwd)
  const tmuxDir = join(cwd, '.tmux-teams')
  const ensureDirectory = (path) => {
    let stat
    try {
      stat = lstatSync(path)
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause
      mkdirSync(path)
      stat = lstatSync(path)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('receipt directory contains a symlink or non-directory component'), { code: 'receipt_directory_invalid' })
  }
  ensureDirectory(tmuxDir)
  for (const path of [receiptsDir, receiptCommitsDir, receiptFailuresDir]) ensureDirectory(path)
  const resolved = realpathSync(receiptsDir)
  if (resolved !== join(governedRoot, '.tmux-teams', 'receipts')) {
    throw Object.assign(new Error('receipt directory resolved outside the governed repository root'), { code: 'receipt_directory_invalid' })
  }
  const commitResolved = realpathSync(receiptCommitsDir)
  if (commitResolved !== join(governedRoot, '.tmux-teams', 'receipt-commits')) {
    throw Object.assign(new Error('receipt commitment directory resolved outside the governed repository root'), { code: 'receipt_directory_invalid' })
  }
  const failureResolved = realpathSync(receiptFailuresDir)
  if (failureResolved !== join(governedRoot, '.tmux-teams', 'receipt-failures')) {
    throw Object.assign(new Error('receipt failure directory resolved outside the governed repository root'), { code: 'receipt_directory_invalid' })
  }
}

function legacyExclusiveReceiptCommit(value) {
  const raw = serializeReceipt(value)
  receiptFailure('serialize')
  receiptFailure('schema')
  ensureReceiptDirectory()
  const publish = () => {
    const temporary = join(receiptsDir, `.${dispatchId}.${process.pid}.${randomUUID()}.tmp`)
    let fd = null
    try {
      fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
      const bytes = Buffer.from(raw, 'utf8')
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      try {
        receiptFailure('directory_fsync')
        linkSync(temporary, receiptPath)
        unlinkSync(temporary)
        fsyncDirectory(receiptsDir)
      } catch (cause) {
        if (cause.code !== 'EEXIST') throw cause
        try { unlinkSync(temporary) } catch {}
        const existing = readReceiptFile(receiptPath)
        if (existing.raw !== raw) throw Object.assign(new Error('receipt dispatch collision has different bytes'), { code: 'receipt_collision' })
        return existing
      }
      return readReceiptFile(receiptPath)
    } finally {
      if (fd !== null) try { closeSync(fd) } catch {}
      try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
    }
  }
  let existing = null
  try {
    existing = readReceiptFile(receiptPath)
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
  }
  if (existing) {
    if (existing.raw !== raw) throw Object.assign(new Error('receipt dispatch collision has different bytes'), { code: 'receipt_collision' })
    receiptFailure('readback')
    return existing
  }
  receiptFailure('write')
  receiptFailure('readback')
  const result = publish()
  if (result.raw !== raw || result.digest !== sha256Text(raw)) throw new Error('receipt readback disagrees with committed bytes')
  return result
}

function fsyncReceiptFile(path) {
  receiptFailure('file_fsync')
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function publishImmutable(path, directory, raw, label) {
  const bytes = Buffer.from(raw, 'utf8')
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(label + ' collision target is not a regular file')
    const existing = readBoundedUtf8(path, MAX_RECEIPT_BYTES, label)
    if (!existing.bytes.equals(bytes)) throw Object.assign(new Error(label + ' collision has different bytes'), { code: 'receipt_collision' })
    return false
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
  }
  const temporary = join(directory, '.' + basename(path) + '.' + process.pid + '.' + randomUUID() + '.tmp')
  let fd = null
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    receiptFailure('file_fsync')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    receiptFailure('publish')
    try {
      linkSync(temporary, path)
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause
      const raced = readBoundedUtf8(path, MAX_RECEIPT_BYTES, label)
      if (!raced.bytes.equals(bytes)) throw Object.assign(new Error(label + ' collision has different bytes'), { code: 'receipt_collision' })
      return false
    } finally {
      try { unlinkSync(temporary) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    }
    receiptFailure('directory_fsync')
    fsyncDirectory(directory)
    return true
  } finally {
    if (fd !== null) try { closeSync(fd) } catch {}
    try { unlinkSync(temporary) } catch {}
  }
}

function readTrustedReceiptPair(dispatch = dispatchId, expectedDigest = null) {
  if (!ID_RE.test(dispatch)) throw new Error('receipt commitment dispatch id is unsafe')
  ensureReceiptDirectory()
  const targetReceiptPath = join(receiptsDir, dispatch + '.json')
  const targetCommitPath = join(receiptCommitsDir, dispatch + '.json')
  const receiptStatBefore = lstatSync(targetReceiptPath)
  const commitStatBefore = lstatSync(targetCommitPath)
  if (!receiptStatBefore.isFile() || receiptStatBefore.isSymbolicLink()
    || !commitStatBefore.isFile() || commitStatBefore.isSymbolicLink()) {
    throw new Error('receipt commitment pair is not regular')
  }
  fsyncReceiptFile(targetReceiptPath)
  fsyncReceiptFile(targetCommitPath)
  receiptFailure('directory_fsync')
  fsyncDirectory(receiptsDir)
  fsyncDirectory(receiptCommitsDir)
  receiptFailure('readback')
  const receipt = readReceiptFile(targetReceiptPath, expectedDigest)
  const commit = readReceiptCommitFile(targetCommitPath)
  const receiptStatAfter = lstatSync(targetReceiptPath)
  const commitStatAfter = lstatSync(targetCommitPath)
  if (receiptStatBefore.dev !== receiptStatAfter.dev || receiptStatBefore.ino !== receiptStatAfter.ino
    || commitStatBefore.dev !== commitStatAfter.dev || commitStatBefore.ino !== commitStatAfter.ino) {
    throw new Error('receipt commitment pair changed during durability proof')
  }
  if (commit.value.dispatch_id !== receipt.value.dispatch_id || commit.value.dispatch_id !== dispatch
    || commit.value.receipt_digest !== receipt.digest || commit.value.committed_state !== 'committed') {
    throw new Error('receipt commitment envelope disagrees with receipt bytes')
  }
  return { ...receipt, commitment: commit.value }
}

function exclusiveReceiptCommit(value) {
  const raw = serializeReceipt(value)
  receiptFailure('serialize')
  receiptFailure('schema')
  ensureReceiptDirectory()
  let existing = null
  try {
    existing = readReceiptFile(receiptPath)
    if (existing.raw !== raw) throw Object.assign(new Error('receipt dispatch collision has different bytes'), { code: 'receipt_collision' })
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
  }
  if (!existing) {
    receiptFailure('write')
    publishImmutable(receiptPath, receiptsDir, raw, 'receipt')
  }
  const visibleReceipt = readReceiptFile(receiptPath)
  if (visibleReceipt.raw !== raw || visibleReceipt.digest !== sha256Bytes(Buffer.from(raw, 'utf8'))) {
    throw new Error('receipt readback disagrees with committed bytes')
  }
  const commitRaw = serializeReceiptCommit(receiptCommitValue(dispatchId, visibleReceipt.digest))
  publishImmutable(receiptCommitPath, receiptCommitsDir, commitRaw, 'receipt commitment')
  return readTrustedReceiptPair(dispatchId, visibleReceipt.digest)
}

function requestedPriorLineage() {
  return {
    priorDispatchId: ID_RE.test(priorDispatchIdEnv) ? priorDispatchIdEnv : null,
    priorReceiptDigest: DIGEST_RE.test(priorReceiptDigestEnv) ? priorReceiptDigestEnv : null,
  }
}

function persistReceiptFailureDiagnostic(cause) {
  try {
    ensureReceiptDirectory()
    mkdirSync(receiptFailuresDir, { recursive: false })
  } catch (directoryCause) {
    if (directoryCause.code !== 'EEXIST') return false
  }
  const lineage = requestedPriorLineage()
  const value = {
    schema: 'acp-session-receipt-failure',
    schema_version: 'acp-session-receipt-failure.v1',
    task_id: taskId,
    dispatch_id: dispatchId,
    requested_operation: operationContext.requestedOperation,
    requested_resume_session_id: operationContext.requestedResumeSessionId,
    prior_dispatch_id: lineage.priorDispatchId,
    prior_receipt_digest: lineage.priorReceiptDigest,
    failure_stage: boundedText(cause?.code ?? 'receipt_persistence_failed', 'receipt_persistence_failed', MAX_TERMINATION_REASON),
    error: boundedText(cause?.message ?? cause, 'receipt persistence failed', MAX_ERROR_TEXT),
  }
  const raw = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_BYTES) return false
  const path = receiptFailurePath
  try {
    const existing = readBoundedUtf8(path, MAX_RECEIPT_BYTES, 'receipt failure diagnostic')
    if (existing.raw !== raw) throw Object.assign(new Error('receipt failure diagnostic collision'), { code: 'receipt_collision' })
    return true
  } catch (readCause) {
    if (readCause.code !== 'ENOENT') return false
  }
  const temporary = join(receiptFailuresDir, '.' + basename(path) + '.' + process.pid + '.' + randomUUID() + '.tmp')
  let fd = null
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    const bytes = Buffer.from(raw, 'utf8')
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    try { linkSync(temporary, path) } catch (publishCause) {
      if (publishCause.code !== 'EEXIST') return false
      const raced = readBoundedUtf8(path, MAX_RECEIPT_BYTES, 'receipt failure diagnostic')
      if (raced.raw !== raw) return false
    }
    fsyncDirectory(receiptFailuresDir)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) try { closeSync(fd) } catch {}
    try { unlinkSync(temporary) } catch {}
  }
}

function priorReceiptForLoad() {
  if (requestedOperationEnv !== 'load') return null
  if (!priorDispatchIdEnv || !priorReceiptDigestEnv) {
    if (receiptRequired) throw new Error('required load is missing prior receipt lineage')
    return null
  }
  if (priorDispatchIdEnv === dispatchId) throw new Error('prior receipt dispatch id must differ from retry dispatch id')
  const result = readTrustedReceiptPair(priorDispatchIdEnv, priorReceiptDigestEnv)
  if (result.value.task_id !== taskId || result.value.dispatch_id !== priorDispatchIdEnv) throw new Error('prior receipt is not for this task/dispatch')
  if (result.value.operation_outcome !== 'succeeded' || !result.value.effective_session_id) throw new Error('prior receipt is not a successful session witness')
  if (result.value.effective_session_id !== explicitResumeId) throw new Error('prior receipt session does not match ACP_RESUME')
  if (result.value.worker !== agentName || result.value.transport !== 'acp') throw new Error('prior receipt worker/transport lineage does not match retry')
  if (result.value.agent_id !== (agentId || null)) throw new Error('prior receipt agent id does not match retry')
  if (result.value.execution_profile_digest !== adapterProfile?.profile_digest) throw new Error('prior receipt execution profile lineage does not match retry')
  if (result.value.initial_agent_mode !== (adapterProfile?.initial_agent_mode ?? null)) throw new Error('prior receipt initial agent mode does not match retry')
  if (result.value.requested_model !== (requestedModel || null)
    || result.value.requested_reasoning_effort !== (requestedReasoningEffort || null)) {
    throw new Error('prior receipt requested identity does not match retry')
  }
  const expectedAgentInfo = adapterProfile?.expected_agent_info
  const expectedCodex = codexReceiptIdentity(adapterProfile?._codex_identity)
  const expectedNode = nodeReceiptIdentity(adapterProfile?._node_identity)
  const expectedEffectiveIdentity = requestedModelExpected
    ? `${requestedModelExpected}${requestedReasoningEffortExpected ? `[${requestedReasoningEffortExpected}]` : ''}`
    : null
  if (result.value.adapter_package_spec !== boundedReceiptText(adapterProfile?.adapter?.package_spec, 'unverified')
    || result.value.adapter_resolved_version !== boundedReceiptText(adapterProfile?.adapter?.resolved_version, 'unverified')
    || result.value.adapter_integrity !== (adapterProfile?.adapter?.integrity ?? null)
    || result.value.adapter_metadata_digest !== (adapterProfile?.adapter?.metadata_digest ?? null)
    || result.value.adapter_entry_digest !== (adapterProfile?.adapter?.entry_digest ?? null)
    || stableJson(result.value.codex_executable_identity) !== stableJson(expectedCodex)
    || stableJson(result.value.node_executable_identity) !== stableJson(expectedNode)
    || (expectedAgentInfo !== null && stableJson(result.value.initialize_agent_info) !== stableJson(expectedAgentInfo))
    || (expectedEffectiveIdentity !== null && result.value.effective_identity !== expectedEffectiveIdentity)
    || (requestedModelExpected && result.value.identity_status !== 'matched')) {
    throw new Error('prior receipt adapter lineage does not match retry')
  }
  return result
}

function parseCommand(value) {
  const parts = String(value ?? '').split(/\s+/).filter(Boolean)
  if (!parts.length || parts.some((part) => part.includes('\u0000'))) throw new Error('ACP command is empty or contains NUL')
  return [parts[0], parts.slice(1)]
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path))
}

function executableIdentity(path, label = 'executable') {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw Object.assign(new Error(`${label} must be an absolute path`), { code: 'invalid_execution_profile' })
  }
  let realpath
  let stat
  try {
    realpath = realpathSync(path)
    stat = lstatSync(realpath)
  } catch (cause) {
    throw Object.assign(new Error(`${label} is unavailable: ${cause.message}`), { code: 'execution_profile_drift' })
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EXECUTABLE_BYTES || (stat.mode & 0o111) === 0) {
    throw Object.assign(new Error(`${label} is not a bounded executable regular file`), { code: 'execution_profile_drift' })
  }
  const versionResult = spawnSync(realpath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const firstVersionLine = `${versionResult.stdout ?? ''}${versionResult.stderr ?? ''}`.split(/\r?\n/).find((line) => line.trim()) ?? ''
  const version = boundedReceiptText(firstVersionLine, 'unavailable')
  if (version === 'unavailable' || versionResult.error || versionResult.status !== 0) {
    throw Object.assign(new Error(`${label} did not produce a successful bounded version identity`), { code: 'execution_profile_drift' })
  }
  return { realpath, digest: sha256File(realpath), version }
}

function commandIdentity(commandName) {
  const which = spawnSync('which', [commandName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const found = which.status === 0 ? which.stdout.trim().split(/\r?\n/).find(Boolean) : null
  if (!found) return { realpath: null, digest: null, version: 'unavailable' }
  try {
    return executableIdentity(realpathSync(found), `${commandName} executable`)
  } catch {
    return { realpath: null, digest: null, version: 'unavailable' }
  }
}

function profileCore(profile) {
  return {
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
}

function validateExecutionProfile(profile, profilePath) {
  if (!exactKeys(profile, ['schema', 'schema_version', 'argv', 'agent_info', 'expected_agent_info', 'initial_agent_mode', 'adapter', 'codex', 'node', 'profile_digest'])
    || profile.schema !== 'acp-execution-profile'
    || profile.schema_version !== 'acp-execution-profile.v1'
    || !Array.isArray(profile.argv) || profile.argv.length < 1 || profile.argv.length > 16
    || !exactKeys(profile.agent_info, ['name', 'version'])
    || !(profile.expected_agent_info === null || exactKeys(profile.expected_agent_info, ['name', 'version']))
    || (profile.initial_agent_mode !== null && (typeof profile.initial_agent_mode !== 'string' || !profile.initial_agent_mode || profile.initial_agent_mode.length > MAX_RECEIPT_TEXT))
    || !exactKeys(profile.adapter, ['package_spec', 'resolved_version', 'integrity', 'metadata_path', 'metadata_digest', 'entry_path', 'entry_digest'])
    || !exactKeys(profile.codex, ['executable_realpath', 'executable_digest', 'version'])
    || !exactKeys(profile.node, ['executable_realpath', 'executable_digest', 'version'])
    || !DIGEST_RE.test(profile.profile_digest)
    || profile.profile_digest !== sha256Text(stableJson(profileCore(profile)))) {
    throw Object.assign(new Error(`invalid closed ACP execution profile ${profilePath}`), { code: 'invalid_execution_profile' })
  }
  for (const arg of profile.argv) {
    if (typeof arg !== 'string' || !arg || arg.length > 512 || /[\u0000\r\n]/.test(arg)) {
      throw Object.assign(new Error('execution profile argv is invalid'), { code: 'invalid_execution_profile' })
    }
  }
  for (const key of ['name', 'version']) {
    if (typeof profile.agent_info[key] !== 'string' || !profile.agent_info[key] || profile.agent_info[key].length > MAX_RECEIPT_TEXT) {
      throw Object.assign(new Error('execution profile initialize agentInfo is invalid'), { code: 'invalid_execution_profile' })
    }
    if (profile.expected_agent_info !== null
      && (typeof profile.expected_agent_info[key] !== 'string' || !profile.expected_agent_info[key] || profile.expected_agent_info[key].length > MAX_RECEIPT_TEXT)) {
      throw Object.assign(new Error('execution profile expected agent identity is invalid'), { code: 'invalid_execution_profile' })
    }
  }
  if (receiptRequired && profile.expected_agent_info === null) {
    throw Object.assign(new Error('required receipt mode needs a pinned expected agent identity'), { code: 'invalid_execution_profile' })
  }
  if (agentName === 'codex' && profile.initial_agent_mode !== effectiveInitialAgentMode) {
    throw Object.assign(new Error('execution profile INITIAL_AGENT_MODE does not match the verified child mode'), { code: 'execution_profile_drift' })
  }
  if (typeof profile.adapter.package_spec !== 'string' || !profile.adapter.package_spec || profile.adapter.package_spec.length > MAX_RECEIPT_TEXT
    || typeof profile.adapter.resolved_version !== 'string' || !profile.adapter.resolved_version || profile.adapter.resolved_version.length > MAX_RECEIPT_TEXT
    || (profile.adapter.integrity !== null && (typeof profile.adapter.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]{16,256}$/.test(profile.adapter.integrity)))
    || (profile.adapter.metadata_path !== null && (typeof profile.adapter.metadata_path !== 'string' || !profile.adapter.metadata_path.startsWith('/')))
    || (profile.adapter.metadata_digest !== null && !DIGEST_RE.test(profile.adapter.metadata_digest))
    || (profile.adapter.entry_path !== null && (typeof profile.adapter.entry_path !== 'string' || !profile.adapter.entry_path.startsWith('/')))
    || (profile.adapter.entry_digest !== null && !DIGEST_RE.test(profile.adapter.entry_digest))) {
    throw Object.assign(new Error('execution profile adapter identity is invalid'), { code: 'invalid_execution_profile' })
  }
  const declaredVersion = profile.adapter.package_spec.match(/@([0-9]+\.[0-9]+\.[0-9]+)$/)?.[1]
  if (declaredVersion && declaredVersion !== profile.adapter.resolved_version) {
    throw Object.assign(new Error('execution profile adapter version disagrees with its pinned package spec'), { code: 'execution_profile_drift' })
  }
  if (profile.adapter.metadata_path !== null) {
    let metadataStat
    try { metadataStat = lstatSync(profile.adapter.metadata_path) } catch { throw Object.assign(new Error('execution profile adapter metadata is unavailable'), { code: 'invalid_execution_profile' }) }
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > MAX_PROFILE_BYTES
      || sha256File(profile.adapter.metadata_path) !== profile.adapter.metadata_digest) {
      throw Object.assign(new Error('execution profile adapter metadata drifted'), { code: 'execution_profile_drift' })
    }
  } else if (profile.adapter.metadata_digest !== null) {
    throw Object.assign(new Error('execution profile adapter metadata path is missing'), { code: 'invalid_execution_profile' })
  }
  if (profile.adapter.entry_path !== null) {
    let entryStat
    try { entryStat = lstatSync(profile.adapter.entry_path) } catch { throw Object.assign(new Error('execution profile adapter entry is unavailable'), { code: 'invalid_execution_profile' }) }
    if (!entryStat.isFile() || entryStat.isSymbolicLink() || entryStat.size > MAX_PROFILE_BYTES
      || sha256File(profile.adapter.entry_path) !== profile.adapter.entry_digest) {
      throw Object.assign(new Error('execution profile adapter entry digest drifted'), { code: 'execution_profile_drift' })
    }
    // Hashing the entry proves a file has not changed. It says nothing about
    // whether that file is the one about to be spawned, and nothing here ever
    // compared the two: a profile could hash a benign entry and point argv at
    // another. argv[0] was already bound to the verified Node executable just
    // below; argv[1] is the script Node then runs, so it is the same fact.
    if (profile.argv[1] !== profile.adapter.entry_path) {
      throw Object.assign(new Error('execution profile argv does not run the adapter entry it verified'), { code: 'execution_profile_drift' })
    }
  }
  for (const [label, value] of [['Node', profile.node], ['Codex', profile.codex]]) {
    if (typeof value.executable_realpath !== 'string' || (value.executable_realpath !== null && !value.executable_realpath.startsWith('/'))
      || typeof value.executable_digest !== 'string' && value.executable_digest !== null
      || (value.executable_digest !== null && !DIGEST_RE.test(value.executable_digest))
      || typeof value.version !== 'string' || !value.version || value.version.length > MAX_RECEIPT_TEXT) {
      throw Object.assign(new Error(`execution profile ${label} identity is invalid`), { code: 'invalid_execution_profile' })
    }
    if (value.executable_realpath !== null) {
      let stat
      try { stat = lstatSync(value.executable_realpath) } catch { throw Object.assign(new Error(`execution profile ${label} executable is unavailable`), { code: 'invalid_execution_profile' }) }
      if (!stat.isFile() || stat.isSymbolicLink() || sha256File(value.executable_realpath) !== value.executable_digest) {
        throw Object.assign(new Error(`execution profile ${label} executable bytes drifted`), { code: 'execution_profile_drift' })
      }
    }
  }
  const nodeIdentity = executableIdentity(profile.node.executable_realpath, 'execution profile Node executable')
  if (profile.argv[0] !== nodeIdentity.realpath || profile.node.executable_digest !== nodeIdentity.digest || profile.node.version !== nodeIdentity.version) {
    throw Object.assign(new Error('execution profile Node identity drifted'), { code: 'execution_profile_drift' })
  }
  if (agentName === 'codex') {
    if (!process.env.CODEX_PATH || !process.env.CODEX_PATH.startsWith('/')) {
      throw Object.assign(new Error('required Codex execution requires an absolute CODEX_PATH'), { code: 'invalid_execution_profile' })
    }
    const actualCodex = executableIdentity(process.env.CODEX_PATH, 'CODEX_PATH executable')
    const pathCodex = commandIdentity('codex')
    if (pathCodex.realpath === null || actualCodex.realpath !== pathCodex.realpath || actualCodex.digest !== pathCodex.digest
      || actualCodex.version !== pathCodex.version
      || actualCodex.realpath !== profile.codex.executable_realpath
      || actualCodex.digest !== profile.codex.executable_digest || actualCodex.version !== profile.codex.version) {
      throw Object.assign(new Error('execution profile Codex identity drifted'), { code: 'execution_profile_drift' })
    }
    if (profile.adapter.package_spec === CODEX_ADAPTER_PACKAGE_SPEC) {
      const adapter = verifyPinnedCodexAdapter()
      if (adapter.package_path !== profile.adapter.metadata_path || adapter.metadata_digest !== profile.adapter.metadata_digest
        || adapter.entry_path !== profile.adapter.entry_path || adapter.entry_digest !== profile.adapter.entry_digest) {
        throw Object.assign(new Error('execution profile pinned adapter resolution drifted'), { code: 'execution_profile_drift' })
      }
    }
  }
  return profile
}

function readExecutionProfile(path) {
  let stat
  try { stat = lstatSync(path) } catch { throw Object.assign(new Error('ACP execution profile is unavailable'), { code: 'invalid_execution_profile' }) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROFILE_BYTES) throw Object.assign(new Error('ACP execution profile must be a bounded regular file'), { code: 'invalid_execution_profile' })
  let profile
  try { profile = JSON.parse(readFileSync(path, 'utf8')) } catch { throw Object.assign(new Error('ACP execution profile is malformed'), { code: 'invalid_execution_profile' }) }
  return validateExecutionProfile(profile, path)
}

function codexReceiptIdentity(identity) {
  return {
    name: boundedReceiptText(identity?.realpath ? basename(identity.realpath) : 'codex', 'codex'),
    realpath_digest: identity?.realpath ? sha256Text(identity.realpath) : null,
    executable_digest: identity?.digest ?? null,
    version: boundedReceiptText(identity?.version, 'unavailable'),
  }
}

function nodeReceiptIdentity(identity) {
  return {
    name: boundedReceiptText(identity?.realpath ? basename(identity.realpath) : 'node', 'node'),
    realpath_digest: identity?.realpath ? sha256Text(identity.realpath) : null,
    executable_digest: identity?.digest ?? null,
    version: boundedReceiptText(identity?.version, 'unavailable'),
  }
}

function resolvePinnedCodexAdapter() {
  const npmCacheResult = spawnSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const cache = npmCacheResult.status === 0 ? npmCacheResult.stdout.trim() : ''
  const roots = [...new Set([
    process.env.NPM_CONFIG_CACHE ? join(process.env.NPM_CONFIG_CACHE, '_npx') : '',
    cache ? join(cache, '_npx') : '',
    join(homedir(), '.npm', '_npx'),
  ].filter(Boolean))]
  const candidates = []
  let drifted = false
  for (const root of roots) {
    const found = spawnSync('find', [root, '-type', 'f', '-path', '*/node_modules/@agentclientprotocol/codex-acp/package.json', '-print'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (found.status !== 0) continue
    for (const packagePath of found.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      try {
        const raw = readFileSync(packagePath, 'utf8')
        if (Buffer.byteLength(raw, 'utf8') > MAX_PROFILE_BYTES) { drifted = true; continue }
        const packageJson = JSON.parse(raw)
        if (packageJson.name !== '@agentclientprotocol/codex-acp' || packageJson.version !== CODEX_ADAPTER_RESOLVED_VERSION) continue
        const target = packageJson.bin?.['codex-acp']
        if (typeof target !== 'string' || target.startsWith('/') || target.includes('..')) { drifted = true; continue }
        const packageRoot = realpathSync(dirname(packagePath))
        const entryPath = realpathSync(join(packageRoot, target))
        const metadataStat = lstatSync(packagePath)
        const entryStat = lstatSync(entryPath)
        const metadataDigest = sha256File(packagePath)
        const entryDigest = sha256File(entryPath)
        if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || !entryStat.isFile() || entryStat.isSymbolicLink()
          || metadataDigest !== CODEX_ADAPTER_METADATA_DIGEST || entryDigest !== CODEX_ADAPTER_ENTRY_DIGEST) {
          drifted = true
          continue
        }
        candidates.push({
          package_path: packagePath,
          package_root: packageRoot,
          metadata_digest: metadataDigest,
          entry_path: entryPath,
          entry_digest: entryDigest,
          integrity: CODEX_ADAPTER_INTEGRITY,
        })
      } catch {
        drifted = true
      }
    }
  }
  if (!candidates.length) {
    throw Object.assign(new Error('locally verified @agentclientprotocol/codex-acp@1.1.7 package is unavailable or drifted'), { code: 'execution_profile_drift' })
  }
  const distinct = new Set(candidates.map((candidate) => stableJson({
    metadata_digest: candidate.metadata_digest,
    entry_digest: candidate.entry_digest,
    integrity: candidate.integrity,
  })))
  if (distinct.size !== 1 || drifted) {
    throw Object.assign(new Error('ambiguous or drifted pinned Codex adapter cache resolution'), { code: 'execution_profile_drift' })
  }
  return candidates.sort((left, right) => left.package_root.localeCompare(right.package_root))[0]
}

function buildBuiltinProfile(cmd) {
  const nodeIdentity = executableIdentity(process.execPath, 'Node executable')
  if (agentName === 'codex' && !process.env.ACP_CMD) {
    if (receiptRequired && (!process.env.CODEX_PATH || !process.env.CODEX_PATH.startsWith('/'))) {
      throw Object.assign(new Error('required Codex execution requires an absolute CODEX_PATH'), { code: 'invalid_execution_profile' })
    }
    const adapter = resolvePinnedCodexAdapter()
    const codexIdentity = executableIdentity(process.env.CODEX_PATH ?? commandIdentity('codex').realpath, 'CODEX_PATH executable')
    const pathCodex = commandIdentity('codex')
    if (pathCodex.realpath === null || codexIdentity.realpath !== pathCodex.realpath
      || codexIdentity.digest !== pathCodex.digest || codexIdentity.version !== pathCodex.version) {
      throw Object.assign(new Error('CODEX_PATH does not match the verified installed Codex executable'), { code: 'execution_profile_drift' })
    }
    return {
      schema: 'acp-execution-profile',
      schema_version: 'acp-execution-profile.v1',
      argv: [nodeIdentity.realpath, adapter.entry_path],
      agent_info: { name: 'tmux-teams-acp-companion', version: '1' },
      expected_agent_info: { name: '@agentclientprotocol/codex-acp', version: CODEX_ADAPTER_RESOLVED_VERSION },
      initial_agent_mode: effectiveInitialAgentMode,
      adapter: {
        package_spec: CODEX_ADAPTER_PACKAGE_SPEC,
        resolved_version: CODEX_ADAPTER_RESOLVED_VERSION,
        integrity: adapter.integrity,
        metadata_path: adapter.package_path,
        metadata_digest: adapter.metadata_digest,
        entry_path: adapter.entry_path,
        entry_digest: adapter.entry_digest,
      },
      codex: { executable_realpath: codexIdentity.realpath, executable_digest: codexIdentity.digest, version: codexIdentity.version },
      node: { executable_realpath: nodeIdentity.realpath, executable_digest: nodeIdentity.digest, version: nodeIdentity.version },
      profile_digest: null,
      _codex_identity: codexIdentity,
      _node_identity: nodeIdentity,
    }
  }
  const packageSpec = process.env.ACP_CMD
    ? 'custom-command'
    : cmd[0] === 'bunx' ? String(cmd[1]?.[0] ?? 'antigravity-acp@1.0.0') : String(cmd[1]?.at(-1) ?? 'custom-command')
  const codexIdentity = agentName === 'codex' ? commandIdentity('codex') : { realpath: null, digest: null, version: 'not_codex' }
  return {
    schema: 'acp-execution-profile',
    schema_version: 'acp-execution-profile.v1',
    argv: [cmd[0], ...cmd[1]],
    agent_info: { name: 'tmux-teams-acp-companion', version: '1' },
    expected_agent_info: null,
    initial_agent_mode: effectiveInitialAgentMode ?? null,
    adapter: {
      package_spec: boundedReceiptText(packageSpec, 'custom-command'),
      resolved_version: packageSpec.match(/@([0-9][^@]*)$/)?.[1] ?? 'unverified',
      integrity: null,
      metadata_path: null,
      metadata_digest: null,
      entry_path: null,
      // A command like `npx -y pkg` names no entry file this process can hash,
      // so there is no entry digest to record. This used to hold the hash of the
      // argv TEXT, which made the receipt read as though executed bytes had been
      // verified when only the words had — and those words are already in
      // `argv`, which `profile_digest` covers, so the hash proved nothing twice.
      entry_digest: null,
    },
    codex: { executable_realpath: codexIdentity.realpath, executable_digest: codexIdentity.digest, version: codexIdentity.version },
    node: { executable_realpath: nodeIdentity.realpath, executable_digest: nodeIdentity.digest, version: nodeIdentity.version },
    profile_digest: null,
    _codex_identity: codexIdentity,
    _node_identity: nodeIdentity,
  }
}

function finalizeBuiltinProfile(profile) {
  const core = profileCore({ ...profile, adapter: { ...profile.adapter }, codex: { ...profile.codex }, node: { ...profile.node } })
  return { ...profile, profile_digest: sha256Text(stableJson(core)) }
}

function verifyPinnedCodexAdapter() {
  return resolvePinnedCodexAdapter()
}

function configureExecutionProfile(cmd) {
  const override = process.env.ACP_EXECUTION_PROFILE
  if (receiptRequired && process.env.ACP_CMD && !override) {
    throw Object.assign(new Error('required receipt mode rejects arbitrary ACP_CMD without ACP_EXECUTION_PROFILE'), { code: 'invalid_execution_profile' })
  }
  if (!override) return finalizeBuiltinProfile(buildBuiltinProfile(cmd))
  if (!receiptRequired && !process.env.ACP_CMD) throw Object.assign(new Error('ACP_EXECUTION_PROFILE is only valid for an explicit command override'), { code: 'invalid_execution_profile' })
  const profile = readExecutionProfile(override)
  const expectedArgv = process.env.ACP_CMD ? [parseCommand(process.env.ACP_CMD)[0], ...parseCommand(process.env.ACP_CMD)[1]] : [cmd[0], ...cmd[1]]
  if (stableJson(profile.argv) !== stableJson(expectedArgv)) throw Object.assign(new Error('ACP execution profile argv does not match ACP_CMD'), { code: 'execution_profile_drift' })
  return { ...profile, _codex_identity: profile.codex.executable_realpath ? {
    realpath: profile.codex.executable_realpath,
    digest: profile.codex.executable_digest,
    version: profile.codex.version,
  } : { realpath: null, digest: null, version: profile.codex.version }, _node_identity: {
    realpath: profile.node.executable_realpath,
    digest: profile.node.executable_digest,
    version: profile.node.version,
  } }
}

function atomicWrite(path, text) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temporary = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text, { mode: 0o600 })
    renameSync(temporary, path)
  } catch (cause) {
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
    throw cause
  }
}

function consumeTerminalPersistenceFailure(stage) {
  if (terminalPersistenceFailureInjected || process.env.ACP_TEST_TERMINAL_PERSISTENCE_FAILURE !== stage) return
  terminalPersistenceFailureInjected = true
  throw Object.assign(new Error(`injected terminal ${stage} persistence failure`), {
    code: `terminal_persistence_${stage}_failure`,
  })
}

function ensureStoreIgnore() {
  const storeDir = join(cwd, '.tmux-teams')
  mkdirSync(storeDir, { recursive: true })
  const ignore = join(storeDir, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 })
}

// The liveness state machine intentionally separates protocol activity from
// meaningful progress. A valid JSON-RPC message can update the former without
// renewing the latter.
let livenessState = 'starting'
let terminationReason = 'none'
let lastProtocolActivityMs = startedMs
let lastMeaningfulProgressMs = startedMs
let meaningfulProgressCount = 0
// GitHub #45 part 2: whether this leg ever got a turn, as opposed to dying at
// the transport (spawn refused, adapter rejected the declared model, provider
// rate-limited before a prompt round-tripped). `meaningfulProgress` already
// fires for a strictly wider set of signals — including the bare protocol
// handshake (`initialize`/`session/new`/`session/load`/
// `session/set_config_option` responses) succeeding, which proves the
// transport works but not that the model was ever asked to do anything.
// `workObserved` narrows that to kinds that are themselves evidence of real
// agent activity: a tool call, a message/thought chunk, a plan update, or a
// completed prompt turn.
//
// `receipt_commit` was on that list and did not belong there. It is not a late
// event: every `tryPersistOperationReceipt` call site (~3192, ~3479, ~3545)
// runs during session setup, and the last of them fires immediately BEFORE
// `session/prompt` is sent (~3573). So it proved the receipt was durable and
// nothing whatever about the model — while making `work_observed` true for a
// leg that then hung, rate-limited, or dropped without a single byte coming
// back. That defeated both things this flag exists for at once: the leg still
// spent a worker attempt (GitHub #45 part 2) AND a palette seat never rotated
// off a dead candidate (GitHub #47, `missesBy`). Found by the v0.15.0 release
// review and reproduced against a hanging mock adapter before this changed.
// Read at the point of
// failure (`recordTerminal`, below) and written onto the `delivered` custody
// line as `work_observed` — the ONE fact the ledger did not have before this,
// and the only channel between this process and the runner that decides
// whether the leg's `assigned` line should draw against the worker's attempt
// budget. A new call site defaults to counting as work (it is excluded here
// explicitly, not included), so an unclassified future kind fails toward a
// spent attempt, never toward a free one.
const HANDSHAKE_ONLY_PROGRESS_KINDS = new Set([
  'initialize_response', 'session_new_response', 'session_load_response', 'session_set_config_option_response',
  // Setup, not work — see above. It still refreshes liveness and the lease.
  'receipt_commit',
])
let workObserved = false
let consecutiveMisses = 0
let leaseAnchorMs = startedMs
let nextLeaseExpiryMs = startedMs + stallMs
let activeSessionId = null
let promptStarted = false
let stallRecoveries = 0
let cancellationUnavailable = false
let cancellationActive = false
let cancellationFinalized = false
let cancellationTargetState = 'stalled'
let cancellationReason = 'stall_confirmed'
let cancellationTimedOut = false
let cancellationAck = false
let cancellationAttempted = false
let cancellationResponseSettled = false
let cancellationGraceStarted = false
let terminationAttempted = false
let terminationDelivered = false
let killAttempted = false
let killDelivered = false
let childSettlementSignalDelivered = false
let descendantCleanupSignalDelivered = false
let forcedReapAttempted = false
let forcedReapDelivered = false
let processKillTimer = null
let cancelGraceTimer = null
let cancelAckTimer = null
let hardTimeoutTimer = null
let livenessTimer = null
let persistenceTimer = null
let persistenceScheduled = false
let terminalRecorded = false
let protocolCompleted = false
let agentClosed = false
let agentCloseResult = null
let agentExitResult = null
let agentError = null
let controllerInterrupted = false
let controllerSignal = null
let controllerSignalCount = 0
let controllerSecondSignal = null
let firstSignalProvenanceDurable = false
let pendingSecondSignal = false
let controllerSignalHandlerInstalled = false
let stderrBuf = ''
let lastErrorText = ''
let protocolFailure = null
let unexpectedExit = null
let terminalSnapshotFinalized = false
let terminalPersistenceFailureInjected = false
const stallHistory = []
const toolsById = new Map()
const activeToolIds = new Map()
const progressFingerprints = new Map()
let planFingerprint = null
let planEntryCount = 0

function requestedConfigOverride(name, limit) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return ''
  const value = raw.trim()
  if (value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    console.error(`invalid ${name} — use a bounded value without control characters`)
    process.exit(2)
  }
  return value
}

// ACP_EXPECT_* remains the explicit identity witness for callers that only
// want verification. ACP_MODEL/ACP_REASONING_EFFORT additionally request a
// per-dispatch session configuration; when no separate expectation is given,
// the requested value becomes the expected value so the adapter cannot claim a
// successful dispatch after the ACP agent silently ignored the override.
// CLAUDE.md prohibits Gemini 3.1 on every tmux-teams route and says to fail
// closed. `review-profiles.mjs` enforced that over the PINNED profile models at
// import — and nothing checked the model an operator REQUESTS at dispatch, which
// is the one an advisor skill taking a model argument would set. Measured
// 2026-08-19: `ACP_MODEL=gemini-3.1-pro-high` on an agy lane was accepted and
// reported `effective_identity: gemini-3.1-pro-high (matched)`, so the identity
// check confirmed the prohibited model rather than refusing it. The AGY adapter
// advertises both 3.1 seats, so this is reachable by typing, not by hacking.
//
// The pattern is COPIED from `review-profiles.mjs` with its source named,
// because this file imports only node builtins on purpose; a test asserts the
// two stay identical, which is the drift answer that does not require coupling
// the two skills.
export const PROHIBITED_MODEL = /(?:^|[^0-9a-z])gemini[-_ ]?3\.1(?:[^0-9]|$)/i

function assertPermittedModel(value, name) {
  if (typeof value === 'string' && PROHIBITED_MODEL.test(value)) {
    console.error(`${name}: Gemini 3.1 is prohibited on tmux-teams routes, got ${value}`)
    process.exit(2)
  }
  return value
}

const requestedModelOverride = assertPermittedModel(
  requestedConfigOverride('ACP_MODEL', MAX_MODEL), 'ACP_MODEL')
const requestedReasoningEffortOverride = requestedConfigOverride('ACP_REASONING_EFFORT', MAX_REASONING_EFFORT)
// The EXPECTATION too: expecting a prohibited model is how a lane would be
// certified as having run one.
const requestedModelExpected = assertPermittedModel(
  process.env.ACP_EXPECT_MODEL?.trim() || requestedModelOverride, 'ACP_EXPECT_MODEL')
const requestedReasoningEffortExpected = process.env.ACP_EXPECT_REASONING_EFFORT?.trim() || requestedReasoningEffortOverride
const requestedModel = boundedText(requestedModelExpected, '', MAX_MODEL)
const requestedReasoningEffort = boundedText(requestedReasoningEffortExpected, '', MAX_REASONING_EFFORT)
let identity = { effectiveIdentity: '', status: requestedModelExpected || requestedReasoningEffortExpected ? 'missing' : 'unverified' }

function noteError(cause) {
  lastErrorText = boundedText(cause?.message ?? cause, 'unknown', MAX_ERROR_TEXT)
}

function failProtocol(cause) {
  if (protocolFailure) return
  protocolFailure = cause instanceof Error ? cause : new Error(String(cause))
  noteError(protocolFailure)
  rejectPending(protocolFailure)
}

function setTerminationReason(value) {
  terminationReason = boundedText(value, 'unknown', MAX_TERMINATION_REASON)
}

function pushBounded(list, value, limit) {
  list.push(value)
  while (list.length > limit) list.shift()
}

function addFingerprint(value) {
  const fingerprint = sha256Text(value)
  if (progressFingerprints.has(fingerprint)) return false
  progressFingerprints.set(fingerprint, true)
  while (progressFingerprints.size > MAX_FINGERPRINTS) progressFingerprints.delete(progressFingerprints.keys().next().value)
  return true
}

function publicTool(tool) {
  return {
    tool_call_id: boundedText(tool.tool_call_id, '', MAX_TOOL_CALL_ID),
    title: boundedText(tool.title ?? tool.label ?? tool.tool_call_id, '', MAX_TOOL_TITLE),
    kind: boundedText(tool.kind, '', MAX_TOOL_KIND),
    status: VALID_TOOL_STATUSES.has(tool.status) ? tool.status : 'pending',
    ...(tool.content_digest ? { content_digest: tool.content_digest } : {}),
    ...(tool.output_digest ? { output_digest: tool.output_digest } : {}),
    ...(tool.locations_digest ? { locations_digest: tool.locations_digest } : {}),
    updated_at: persistedTimestamp(tool.updated_at),
    update_count: Math.min(MAX_TOOL_UPDATE_COUNT, Math.max(1, Number(tool.update_count) || 1)),
  }
}

function toolComparable(tool) {
  return Object.fromEntries(
    Object.entries(publicTool(tool)).filter(([key]) => key !== 'updated_at' && key !== 'update_count'),
  )
}

function activeToolEvidence(limit = MAX_ACTIVE_TOOL_EVIDENCE) {
  const boundedLimit = Math.max(0, Math.min(MAX_ACTIVE_TOOL_EVIDENCE, Math.floor(Number(limit) || 0)))
  return [...activeToolIds.keys()].slice(0, boundedLimit).map((id) => {
    const tool = toolsById.get(id) ?? activeToolIds.get(id)
    return publicTool(tool)
  })
}

function currentActiveToolEvidence(limit = MAX_ACTIVE_TOOL_EVIDENCE) {
  return isLivenessTerminal() ? [] : activeToolEvidence(limit)
}

function compareNewestToolRecords([leftId, left], [rightId, right]) {
  const leftTimestamp = String(left.updated_at ?? '')
  const rightTimestamp = String(right.updated_at ?? '')
  if (leftTimestamp !== rightTimestamp) return leftTimestamp < rightTimestamp ? 1 : -1
  const leftCount = Number(left.update_count) || 0
  const rightCount = Number(right.update_count) || 0
  if (leftCount !== rightCount) return leftCount < rightCount ? 1 : -1
  return leftId.localeCompare(rightId)
}

function compareOldestToolRecords([leftId, left], [rightId, right]) {
  const result = compareNewestToolRecords([rightId, right], [leftId, left])
  return result || leftId.localeCompare(rightId)
}

function toolProjection(limit = MAX_PUBLIC_TOOL_RECORDS) {
  const boundedLimit = Math.max(0, Math.min(MAX_PUBLIC_TOOL_RECORDS, Math.floor(Number(limit) || 0)))
  const visibleActive = activeToolEvidence(Math.min(MAX_ACTIVE_TOOL_EVIDENCE, boundedLimit))
  const selected = new Map(visibleActive.map((tool) => [tool.tool_call_id, tool]))
  const visibleActiveIds = new Set(selected.keys())
  const newestUseful = [...toolsById.entries()]
    .filter(([id]) => !visibleActiveIds.has(id))
    .sort(compareNewestToolRecords)
  for (const [id, tool] of newestUseful) {
    if (selected.size >= boundedLimit) break
    selected.set(id, publicTool(tool))
  }
  return {
    active_tools: visibleActive,
    tools: Object.fromEntries(selected),
  }
}

function snapshotData({ toolLimit = MAX_PUBLIC_TOOL_RECORDS, historyLimit = MAX_STALL_HISTORY, minimal = false } = {}) {
  const projection = toolProjection(toolLimit)
  const boundedHistoryLimit = Math.max(0, Math.min(MAX_STALL_HISTORY, Math.floor(Number(historyLimit) || 0)))
  const visibleHistory = boundedHistoryLimit === 0 ? [] : stallHistory.slice(-boundedHistoryLimit)
  const snapshot = {
    schema_version: 'acp-liveness.v1',
    task_id: taskId,
    dispatch_id: boundedText(dispatchId, 'unknown', MAX_DISPATCH_ID),
    worker: boundedText(agentName, 'unknown', MAX_WORKER),
    transport: 'acp',
    session_id: persistedSessionId(activeSessionId),
    started_at: persistedTimestamp(startedAt),
    observed_at: persistedTimestamp(iso(Date.now())),
    stall_sec: stallSec,
    hard_timeout_sec: hardTimeoutSec,
    stall_policy: stallPolicy,
    cancellation_grace_sec: cancelGraceMs / 1000,
    liveness_state: livenessState,
    termination_reason: boundedText(terminationReason, 'unknown', MAX_TERMINATION_REASON),
    last_protocol_activity_at: persistedTimestamp(iso(lastProtocolActivityMs)),
    last_meaningful_progress_at: persistedTimestamp(iso(lastMeaningfulProgressMs)),
    lease_anchor_at: persistedTimestamp(iso(leaseAnchorMs)),
    meaningful_progress_count: meaningfulProgressCount,
    consecutive_missed_leases: consecutiveMisses,
    next_lease_expiry_at: persistedTimestamp(iso(nextLeaseExpiryMs)),
    stall_recoveries: stallRecoveries,
    stall_history: visibleHistory,
    active_tools: isLivenessTerminal() ? [] : projection.active_tools,
    tools: projection.tools,
    plan_digest: minimal ? null : planFingerprint,
    plan_entry_count: minimal ? 0 : planEntryCount,
    cancellation_unavailable: cancellationUnavailable,
    requested_model: minimal ? null : (requestedModel || null),
    requested_reasoning_effort: minimal ? null : (requestedReasoningEffort || null),
    effective_identity: minimal ? null : (identity.effectiveIdentity || null),
    identity_status: minimal ? 'unverified' : identity.status,
    // The same fact ข้อ 4.10 defines, carried on the channel that works for EVERY
    // leg. The custody write below is a no-op when `workItem` is empty, which
    // is exactly how the outer controller's own leg is spawned — so for that
    // leg the ledger can never answer "did the model ever get a turn", and
    // GitHub #52 destroyed finished tokens because the only reader had to
    // guess. This snapshot is written unconditionally, so it can answer.
    // Never `minimal`-gated: it is one boolean and it decides whether a token
    // is retried or hard-abandoned.
    work_observed: workObserved,
  }
  if (agentId) snapshot.agent_id = boundedText(agentId, '', MAX_WORKER)
  // CONDITIONAL, not `null` when absent: a loop-runner lane never sets
  // `ACP_SPAWN_NONCE`, and an unconditional field here would put a `spawn_nonce:
  // null` into every snapshot that never had one, moving bytes no reader asked
  // to see move.
  if (spawnNonce) snapshot.spawn_nonce = boundedText(spawnNonce, '', MAX_SPAWN_NONCE)
  return snapshot
}

function serializedSnapshot() {
  const serialize = (options) => `${JSON.stringify(snapshotData(options), null, 2)}\n`
  let toolLimit = MAX_PUBLIC_TOOL_RECORDS
  let historyLimit = MAX_STALL_HISTORY
  let text = serialize({ toolLimit, historyLimit })

  // Public tools are active-first. Lowering the limit therefore drops the
  // oldest non-active records before it removes any visible active evidence.
  const visibleActiveCount = activeToolEvidence().length
  while (Buffer.byteLength(text, 'utf8') > snapshotByteBudget && toolLimit > visibleActiveCount) {
    toolLimit -= 1
    text = serialize({ toolLimit, historyLimit })
  }
  // If tool metadata is still too large, discard older history before
  // considering the small visible active subset.
  while (Buffer.byteLength(text, 'utf8') > snapshotByteBudget && historyLimit > 0) {
    historyLimit -= 1
    text = serialize({ toolLimit, historyLimit })
  }
  while (Buffer.byteLength(text, 'utf8') > snapshotByteBudget && toolLimit > 0) {
    toolLimit -= 1
    text = serialize({ toolLimit, historyLimit })
  }
  if (Buffer.byteLength(text, 'utf8') > snapshotByteBudget) {
    // All variable collections are gone. The minimal v1-shaped terminal
    // snapshot still records the current state and cannot retain raw tool
    // content or a stale pre-terminal projection.
    text = serialize({ toolLimit: 0, historyLimit: 0, minimal: true })
    console.error('[liveness] using minimal bounded snapshot fallback')
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(`ACP liveness snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`)
  if (bytes > snapshotByteBudget) {
    console.error(`[liveness] irreducible v1 snapshot is ${bytes} bytes; artificial target is ${snapshotByteBudget}`)
  }
  return text
}

function writeLivenessSnapshot({ required = false } = {}) {
  try {
    ensureStoreIgnore()
    const text = serializedSnapshot()
    if (required) consumeTerminalPersistenceFailure('write')
    atomicWrite(livenessPath, text)
    return text
  } catch (cause) {
    if (required) throw cause
    console.error(`[warn] could not persist ACP liveness snapshot: ${boundedText(cause.message, 'write failed', MAX_ERROR_TEXT)}`)
    return null
  }
}

function dispatchRecordText() {
  const lines = [
    `dispatch_id: ${boundedText(dispatchId, 'unknown', MAX_DISPATCH_ID)}`,
    `task_id: ${taskId}`,
    `worker: ${boundedText(agentName, 'unknown', MAX_WORKER)}`,
    'transport: acp',
    ...(agentId ? [`agent_id: ${boundedText(agentId, '', MAX_WORKER)}`] : []),
    ...(deliveryWorkflow ? [`workflow: ${deliveryWorkflow}`] : []),
    ...(workItem ? [`work_item: ${workItem}`] : []),
    `started_at: ${persistedTimestamp(startedAt)}`,
    `stall_sec: ${stallSec}`,
    `timeout_sec: ${stallSec}`,
    `hard_timeout_sec: ${hardTimeoutSec}`,
    `stall_policy: ${stallPolicy}`,
    `termination_reason: ${boundedText(terminationReason, 'unknown', MAX_TERMINATION_REASON)}`,
    `liveness_persistence_failed: ${terminationReason === 'liveness_persistence_failed'}`,
    `receipt_persistence_failed: ${terminationReason === 'receipt_persistence_failed'}`,
    `liveness_state: ${livenessState}`,
    `last_protocol_activity_at: ${persistedTimestamp(iso(lastProtocolActivityMs))}`,
    `last_meaningful_progress_at: ${persistedTimestamp(iso(lastMeaningfulProgressMs))}`,
    `meaningful_progress_count: ${meaningfulProgressCount}`,
    `active_tools: ${JSON.stringify(currentActiveToolEvidence())}`,
    `liveness_path: .tmux-teams/liveness/${taskId}.json`,
    `receipt_digest: ${receiptDigest ?? 'none'}`,
    `requested_model: ${boundedText(requestedModel, 'none', MAX_MODEL)}`,
    `requested_reasoning_effort: ${boundedText(requestedReasoningEffort, 'none', MAX_REASONING_EFFORT)}`,
    `effective_identity: ${boundedText(identity.effectiveIdentity, 'missing', MAX_MODEL + MAX_REASONING_EFFORT + 2)}`,
    `identity_status: ${boundedText(identity.status, 'unverified', MAX_TEXT)}`,
    `error: ${boundedText(lastErrorText || stderrBuf, 'none', MAX_ERROR_TEXT)}`,
  ]
  return `${lines.join('\n')}\n`
}

// Append-only, one line per custody event. Appending never rewrites what came
// before, so two agents holding legs of the same token cannot lose each other's
// history, and a crash mid-write costs at most the last line.
function appendWorkItemEvent(event, extra = {}) {
  if (!workItem) return
  try {
    mkdirSync(workItemsDir, { recursive: true, mode: 0o700 })
    // Through the sanctioned writer, never straight to the file. ข้อ 13 names this
    // process a writer and binds it to the same obligations as the runner:
    // validate the event, and refuse to append to a history that is already
    // broken. It used to `appendFileSync` directly, so a probe could start from
    // an invalid ledger, watch this companion exit 0 having recorded two more
    // events, then watch `ledger-validate` exit 1 on the very file it had just
    // written — the transport reporting custody the control plane rejects.
    //
    // A refusal is loud and the leg is NOT recorded, which is the point: a
    // custody line appended onto a history nobody can believe is worth less
    // than the absence that makes somebody look.
    // `locked` is the ONE refusal that says nothing about the event: another
    // process held the ledger's lock, and the very next attempt may write it.
    // Every other code is a verdict on the bytes and must not be retried. This
    // matters because the branch below treats a refusal as evidence worth
    // leaving absent — correct for a verdict, wrong for contention, and a lost
    // custody line is the one thing this ledger exists to prevent. AGY raised
    // it in round six: the lock landed with no caller taught to tell the two
    // apart. `appendEvent` already waits `LOCK_MAX_WAIT_MS` inside each call,
    // so these are whole extra waits, not a spin.
    let result
    for (let attempt = 0; ; attempt += 1) {
      result = appendEvent(cwd, buildCustodyEvent(), { actor: agentId ? `agent:${agentId}` : 'agent:acp-companion' })
      if (result.ok || result.code !== 'locked' || attempt >= LOCKED_APPEND_RETRIES) break
      console.error(`[warn] ledger busy, retrying custody append (${attempt + 1}/${LOCKED_APPEND_RETRIES})`)
    }
    if (!result.ok) {
      console.error(`[warn] custody REFUSED (${result.code}): ${boundedText(result.detail ?? '', 'no detail', MAX_ERROR_TEXT)}`)
    }
  } catch (cause) {
    console.error(`[warn] could not record work item custody: ${boundedText(cause.message, 'append failed', MAX_ERROR_TEXT)}`)
  }

  function buildCustodyEvent() {
    return {
      at: new Date().toISOString(),
      event,
      work_item: workItem,
      workflow: deliveryWorkflow || null,
      agent_id: agentId || null,
      task_id: taskId,
      dispatch_id: dispatchId,
      ...extra,
    }
  }
}

let workItemAssigned = false

function writeDispatchRecord({ required = false } = {}) {
  try {
    ensureStoreIgnore()
    const text = dispatchRecordText()
    if (required) consumeTerminalPersistenceFailure('dispatch')
    atomicWrite(dispatchPath, text)
    // Custody starts the first time this dispatch is durable, not on every
    // refresh of the record — one leg of the journey is one assignment.
    if (!workItemAssigned) {
      workItemAssigned = true
      // GitHub #47 phase 2b (ข้อ 3.5.1, ข้อ 4): which model this leg was dispatched
      // ON. Until a seat could declare a palette, the ledger answered this by
      // inference — one seat, one model, look it up in the graph — and a
      // palette destroys that inference for exactly the legs where the answer
      // matters most. Both halves are needed: a palette may hold the same
      // model on two lanes (different buckets, so legal even adjacent), and
      // `opus` names different vendors on different lanes.
      //
      // This is the REQUEST, written before spawn, not the verified identity:
      // at this point no adapter has answered. `effective_identity` on the
      // dispatch record is the verified fact and arrives later — these two are
      // different facts and the ledger says which one it is holding.
      appendWorkItemEvent('assigned', { requested_model: requestedModel || null, adapter: agentName })
    }
    return text
  } catch (cause) {
    if (required) throw cause
    console.error(`[warn] could not update dispatch liveness record: ${boundedText(cause.message, 'write failed', MAX_ERROR_TEXT)}`)
    return null
  }
}

function flushPersistence() {
  if (persistenceTimer) clearTimeout(persistenceTimer)
  persistenceTimer = null
  persistenceScheduled = false
  // Dispatch record FIRST, liveness second, and the order is load-bearing. The
  // runner reads the liveness file to learn a leg is alive and the paired
  // dispatch record to learn WHICH TOKEN it holds. Writing liveness first left
  // a window where a restarted runner saw a live seat with no token — a release
  // reviewer probed exactly that intermediate state and got `busyItems=[]` with
  // the same token dispatched onto a second seat (codex lane, 2026-08-11).
  // Reversed, a reader that can see the liveness file can always see the record
  // behind it, and the worst intermediate state is a record with no liveness
  // yet — which reserves nothing and blocks nothing.
  writeDispatchRecord()
  writeLivenessSnapshot()
}

function schedulePersistence(immediate = false) {
  if (immediate) {
    flushPersistence()
    return
  }
  if (persistenceScheduled) return
  persistenceScheduled = true
  persistenceTimer = setTimeout(() => {
    persistenceTimer = null
    persistenceScheduled = false
    // Same order as `flushPersistence`, for the same reason.
    writeDispatchRecord()
    writeLivenessSnapshot()
  }, persistenceIntervalMs)
}

function setLivenessState(next) {
  if (livenessState === next) return
  livenessState = next
  console.error(`[liveness] ${next}`)
  schedulePersistence()
}

function addStallHistory(event) {
  if (!VALID_STALL_HISTORY_STATES.has(event?.state)) return
  const record = {
    state: event.state,
    evidence: boundedText(event.evidence, 'unknown', MAX_STALL_EVIDENCE),
    observed_at: persistedTimestamp(event.observed_at),
  }
  if (event.reason !== undefined) record.reason = boundedText(event.reason, 'unknown', MAX_TERMINATION_REASON)
  if (event.last_protocol_activity_at) {
    record.last_protocol_activity_at = persistedTimestamp(event.last_protocol_activity_at)
  }
  if (event.last_meaningful_progress_at) {
    record.last_meaningful_progress_at = persistedTimestamp(event.last_meaningful_progress_at)
  }
  if (Array.isArray(event.active_tools)) {
    record.active_tools = event.active_tools.slice(0, MAX_STALL_HISTORY_ACTIVE_TOOLS).map(publicTool)
  }
  pushBounded(stallHistory, record, MAX_STALL_HISTORY)
}

function isLivenessTerminal() {
  return terminalRecorded || terminalSnapshotFinalized || VALID_TERMINAL_STATES.has(livenessState)
}

function noteProtocolActivity() {
  lastProtocolActivityMs = Date.now()
  schedulePersistence()
}

function sessionMatches(message) {
  const sessionId = message?.params?.sessionId
  return Boolean(sessionId && activeSessionId && sessionId === activeSessionId)
}

function meaningfulProgress(kind, details = {}) {
  if (terminalRecorded || cancellationActive) return
  const now = Date.now()
  const wasSuspected = livenessState === 'suspected_stalled'
  const wasReportedStall = livenessState === 'stalled' && stallPolicy === 'report'
  lastMeaningfulProgressMs = now
  leaseAnchorMs = now
  meaningfulProgressCount = Math.min(Number.MAX_SAFE_INTEGER, meaningfulProgressCount + 1)
  if (!HANDSHAKE_ONLY_PROGRESS_KINDS.has(kind)) workObserved = true
  consecutiveMisses = 0
  nextLeaseExpiryMs = now + stallMs
  if (wasSuspected || wasReportedStall) {
    stallRecoveries += 1
    addStallHistory({ state: 'recovered', evidence: boundedText(kind) })
    setTerminationReason('none')
  }
  if (promptStarted) setLivenessState(activeToolIds.size > 0 ? 'tool_running' : 'active')
  schedulePersistence()
  if (details.label) console.error(`[liveness] progress ${boundedText(details.label)}`)
}

function digestIfPresent(value) {
  if (value === undefined) return undefined
  let serialized
  try { serialized = stableJson(value) } catch { serialized = String(value) }
  return sha256Text(serialized.slice(0, MAX_DIGEST_INPUT))
}

function normalizeToolStatus(value, fallback = 'pending') {
  if (value === undefined) return fallback
  return typeof value === 'string' && VALID_TOOL_STATUSES.has(value) ? value : null
}

function toolUpdate(update) {
  const toolCallId = boundedText(update?.toolCallId ?? update?.tool_call_id, '', MAX_TOOL_CALL_ID)
  if (!toolCallId) return
  const previous = toolsById.get(toolCallId)
  const suppliedStatus = Object.prototype.hasOwnProperty.call(update ?? {}, 'status')
  const status = normalizeToolStatus(suppliedStatus ? update.status : previous?.status)
  if (!status) {
    console.error(`[liveness] invalid ACP tool status for ${toolCallId}; failing closed`)
    failProtocol(new Error('invalid ACP v1 tool status'))
    return
  }
  const next = {
    tool_call_id: toolCallId,
    title: boundedText(update.title ?? previous?.title, '', MAX_TOOL_TITLE),
    kind: boundedText(update.kind ?? previous?.kind, '', MAX_TOOL_KIND),
    status,
    content_digest: digestIfPresent(update.content) ?? previous?.content_digest,
    output_digest: digestIfPresent(update.rawOutput ?? update.output) ?? previous?.output_digest,
    locations_digest: digestIfPresent(update.locations) ?? previous?.locations_digest,
    updated_at: iso(Date.now()),
    update_count: Math.min(MAX_TOOL_UPDATE_COUNT, (previous?.update_count ?? 0) + 1),
  }
  const changed = !previous || stableJson(toolComparable(previous)) !== stableJson(toolComparable(next))
  if (changed) {
    toolsById.set(toolCallId, next)
    if (next.status === 'in_progress') activeToolIds.set(toolCallId, next)
    else activeToolIds.delete(toolCallId)
    while (activeToolIds.size > MAX_ACTIVE_TOOLS) activeToolIds.delete(activeToolIds.keys().next().value)
    if (toolsById.size > MAX_INTERNAL_TOOL_RECORDS) {
      const removable = [...toolsById.entries()]
        .filter(([id]) => !activeToolIds.has(id))
        .sort(compareOldestToolRecords)[0]?.[0]
      if (removable) toolsById.delete(removable)
    }
    meaningfulProgress('tool', { label: `${toolCallId}:${next.status}` })
    if (next.status === 'in_progress') {
      schedulePersistence(true)
      recordTestStage('tool-running')
    }
  }
}

function updateTextProgress(update) {
  if (update?.content?.type !== 'text') return
  const text = String(update.content.text ?? '')
  if (!text.trim()) return
  const key = stableJson([update.sessionUpdate, update.messageId ?? '', text.slice(0, MAX_DIGEST_INPUT)])
  if (!addFingerprint(key)) return
  meaningfulProgress('message', { label: update.sessionUpdate })
}

function updatePlanProgress(update) {
  const entries = Array.isArray(update?.entries) ? update.entries.slice(0, MAX_PLAN_ENTRIES) : []
  if (!entries.length) return
  const next = sha256Text(stableJson(entries))
  if (next === planFingerprint) return
  planFingerprint = next
  planEntryCount = entries.length
  meaningfulProgress('plan', { label: 'changed' })
}

function handleUpdate(update) {
  switch (update?.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      updateTextProgress(update)
      break
    case 'tool_call':
    case 'tool_call_update':
      toolUpdate(update)
      break
    case 'plan':
      updatePlanProgress(update)
      break
    default:
      break
  }
}

function extractIdentity(session) {
  const options = Array.isArray(session?.configOptions) ? session.configOptions : []
  const optionValue = (id) => {
    const option = options.find((item) => item?.id === id)
    return typeof option?.currentValue === 'string' ? option.currentValue.trim() : ''
  }
  const currentModelId = typeof session?.models?.currentModelId === 'string'
    ? session.models.currentModelId.trim() : ''
  const configuredModel = optionValue('model')
  const configuredReasoningEffort = optionValue('reasoning_effort')
  let baseModel = ''
  let reasoningEffort = ''
  const currentMatch = currentModelId.match(/^(.+?)\[([^\]]+)\]$/)
  // A config-options response is the ACP witness returned by
  // session/set_config_option. Prefer it over the original models field so a
  // post-session override cannot be masked by stale startup metadata.
  if (configuredModel) {
    baseModel = configuredModel
    reasoningEffort = configuredReasoningEffort
  } else if (currentMatch) {
    baseModel = currentMatch[1].trim()
    reasoningEffort = currentMatch[2].trim()
  } else if (currentModelId) {
    baseModel = currentModelId
  }
  if (!baseModel) baseModel = optionValue('model')
  if (!reasoningEffort) reasoningEffort = optionValue('reasoning_effort')
  const normalizedModel = boundedText(baseModel, '', MAX_MODEL)
  const normalizedReasoningEffort = boundedText(reasoningEffort, '', MAX_REASONING_EFFORT)
  const effectiveIdentity = normalizedModel
    ? (normalizedReasoningEffort ? `${normalizedModel}[${normalizedReasoningEffort}]` : normalizedModel)
    : ''
  const identityRequested = requestedModelExpected || requestedReasoningEffortExpected
  // A seat that sets neither ACP_MODEL nor ACP_EXPECT_MODEL (the
  // INHERIT_ACCOUNT_DEFAULT sentinel loop-runner sends for a seat that wants
  // "whatever the account defaults to") reaches this function with
  // identityRequested false — the branch below would otherwise report
  // 'unverified' and enforceIdentity returns without ever comparing
  // effectiveIdentity to PROHIBITED_MODEL. CLAUDE.md's own casebook records
  // the AGY adapter's default drifting between releases without this repo
  // noticing, so an account default is exactly the value that must still be
  // checked — the refusal here does not depend on anything having been
  // requested. Checked before the requested/expected branch so a lane cannot
  // land on 'matched' or 'unverified' while running a prohibited model.
  const prohibited = normalizedModel !== '' && PROHIBITED_MODEL.test(normalizedModel)
  const status = prohibited ? 'mismatched' :
    !identityRequested ? 'unverified' :
    (!normalizedModel || (requestedReasoningEffortExpected && !normalizedReasoningEffort) ? 'missing' :
      (requestedModelExpected && baseModel !== requestedModelExpected) ||
      (requestedReasoningEffortExpected && reasoningEffort !== requestedReasoningEffortExpected)
        ? 'mismatched' : 'matched')
  return { effectiveIdentity, status }
}

function configOption(response, id) {
  const options = Array.isArray(response?.configOptions) ? response.configOptions : []
  return options.find((option) => option?.id === id) ?? null
}

function assertConfigOptionValue(response, id, value, phase) {
  const option = configOption(response, id)
  if (!option) {
    throw Object.assign(new Error(`${phase} did not advertise ACP config option ${id}`), {
      code: 'config-option-unsupported',
    })
  }
  // antigravity-acp 1.0.0 advertises model option values as "<id>\t<display
  // label>" while its session/set_config_option accepts the bare id and
  // reports it back bare — the bare id is the value the agent itself
  // considers applied (probed against agy 1.1.12, 2026-08-12). Match both
  // forms here, or every agy seat dies at this pre-check with a value the
  // server would have accepted.
  if (Array.isArray(option.options)
    && !option.options.some((candidate) => candidate?.value === value
      || (typeof candidate?.value === 'string' && candidate.value.split('\t')[0] === value))) {
    throw Object.assign(new Error(`${phase} rejected unsupported ${id} value ${value}`), {
      code: 'config-option-invalid',
    })
  }
  return option
}

async function applyRequestedSessionConfig(sessionId, response) {
  const requested = [
    ['model', requestedModelOverride],
    ['reasoning_effort', requestedReasoningEffortOverride],
  ].filter(([, value]) => value)
  if (!requested.length) return response

  let effectiveResponse = response
  for (const [configId, value] of requested) {
    assertConfigOptionValue(effectiveResponse, configId, value, 'ACP session response')
    const result = await request('session/set_config_option', {
      sessionId,
      configId,
      value,
    })
    assertProtocolFence(`session/set_config_option(${configId}) response`)
    if (!Array.isArray(result?.configOptions)) {
      throw Object.assign(new Error(`ACP session/set_config_option(${configId}) returned no configOptions`), {
        code: 'config-option-response-invalid',
      })
    }
    effectiveResponse = { ...effectiveResponse, configOptions: result.configOptions }
    const applied = assertConfigOptionValue(
      effectiveResponse,
      configId,
      value,
      `ACP session/set_config_option(${configId}) response`,
    )
    if (applied.currentValue !== value) {
      throw Object.assign(new Error(`ACP agent did not apply ${configId}=${value}`), {
        code: 'config-option-not-applied',
      })
    }
  }
  return effectiveResponse
}

function observedAgentInfo(response) {
  const info = response?.agentInfo
  if (!info || typeof info !== 'object' || Array.isArray(info)
    || typeof info.name !== 'string' || !info.name.trim()
    || typeof info.version !== 'string' || !info.version.trim()) return null
  return {
    name: boundedReceiptText(info.name, '', MAX_RECEIPT_TEXT),
    version: boundedReceiptText(info.version, '', MAX_RECEIPT_TEXT),
  }
}

function enforceObservedInitializeIdentity(response) {
  const observed = observedAgentInfo(response)
  if (operationContext.initializeTrace) operationContext.initializeTrace.observed_agent_info = observed
  const expected = adapterProfile?.expected_agent_info ?? null
  if (!observed) {
    if (expected !== null || receiptRequired) {
      identity = { ...identity, status: 'missing' }
      throw Object.assign(new Error('initialize response did not contain a bounded agent identity'), { code: 'initialize-identity-missing' })
    }
    return
  }
  if (expected !== null && stableJson(observed) !== stableJson(expected)) {
    identity = { ...identity, status: 'mismatched' }
    throw Object.assign(new Error('initialize response agent identity differs from the pinned execution profile'), { code: 'initialize-identity-mismatch' })
  }
}

function enforceIdentity(session) {
  identity = extractIdentity(session)
  writeDispatchRecord()
  schedulePersistence()
  if (identity.status === 'unverified' || identity.status === 'matched') return
  // Name the specific policy this lane just broke, not only the generic
  // mismatch — the gap this closes was reported with "no console.error, no
  // exit(2), no signal" that CLAUDE.md's fail-closed rule had been violated.
  if (PROHIBITED_MODEL.test(identity.effectiveIdentity)) {
    console.error(`observed session model: Gemini 3.1 is prohibited on tmux-teams routes, got ${identity.effectiveIdentity}`)
  }
  const terminal = identity.status === 'missing' ? 'identity-missing' : 'identity-mismatch'
  const expected = `${requestedModel || 'missing'}${requestedReasoningEffort ? `[${requestedReasoningEffort}]` : ''}`
  throw Object.assign(new Error(`identity ${identity.status}: expected ${expected}, effective ${identity.effectiveIdentity || 'missing'}`), {
    code: terminal,
  })
}

function unavailableReceiptProfile() {
  return {
    agent_info: { name: 'tmux-teams-acp-companion', version: '1' },
    expected_agent_info: null,
    initial_agent_mode: null,
    adapter: {
      package_spec: 'unverified',
      resolved_version: 'unverified',
      integrity: null,
      metadata_digest: null,
      entry_digest: null,
    },
    codex: { executable_realpath: null, executable_digest: null, version: 'unavailable' },
    node: { executable_realpath: null, executable_digest: null, version: 'unavailable' },
    profile_digest: null,
  }
}

function receiptRecordFor({
  requestedOperation,
  performedOperation = null,
  operationOutcome,
  requestedResumeSessionId = null,
  effectiveSessionId = null,
  priorReceipt = null,
  priorDispatchId = null,
  priorReceiptDigest = null,
  operationWitness = 'none',
  operationTrace = null,
  resumeStatus = 'not_requested',
} = {}) {
  const profile = adapterProfile ?? unavailableReceiptProfile()
  const codexIdentity = profile._codex_identity ?? {
    realpath: profile.codex?.executable_realpath ?? null,
    digest: profile.codex?.executable_digest ?? null,
    version: profile.codex?.version ?? 'unavailable',
  }
  const nodeIdentity = profile._node_identity ?? {
    realpath: profile.node?.executable_realpath ?? null,
    digest: profile.node?.executable_digest ?? null,
    version: profile.node?.version ?? 'unavailable',
  }
  const operationAcknowledged = Boolean(operationTrace?.correlated)
  const value = {
    schema: RECEIPT_SCHEMA,
    schema_version: RECEIPT_SCHEMA_VERSION,
    task_id: taskId,
    dispatch_id: dispatchId,
    agent_id: agentId || null,
    worker: boundedReceiptText(agentName, 'unknown', MAX_WORKER),
    transport: 'acp',
    requested_operation: requestedOperation,
    performed_operation: performedOperation,
    operation_outcome: operationOutcome,
    requested_resume_session_id: requestedResumeSessionId,
    effective_session_id: effectiveSessionId,
    prior_dispatch_id: priorReceipt?.value?.dispatch_id ?? priorDispatchId,
    prior_receipt_digest: priorReceipt?.digest ?? priorReceiptDigest,
    operation_witness: operationWitness,
    operation_request_digest: operationTrace?.request_digest ?? null,
    operation_response_digest: operationTrace?.response_digest ?? null,
    operation_rpc_id: operationTrace?.id ?? null,
    operation_acknowledged_at: operationAcknowledged ? persistedTimestamp(operationTrace?.acknowledged_at) : null,
    requested_model: boundedReceiptText(requestedModel, '') || null,
    requested_reasoning_effort: boundedReceiptText(requestedReasoningEffort, '') || null,
    effective_identity: boundedReceiptText(identity.effectiveIdentity, '') || null,
    identity_status: RECEIPT_IDENTITY_STATUSES.has(identity.status) ? identity.status : 'unverified',
    adapter_package_spec: boundedReceiptText(profile.adapter?.package_spec, 'unverified'),
    adapter_resolved_version: boundedReceiptText(profile.adapter?.resolved_version, 'unverified'),
    adapter_integrity: profile.adapter?.integrity ?? null,
    adapter_metadata_digest: profile.adapter?.metadata_digest ?? null,
    adapter_entry_digest: profile.adapter?.entry_digest ?? null,
    initialize_agent_info: operationContext.initializeTrace?.observed_agent_info ?? null,
    execution_profile_digest: profile.profile_digest ?? null,
    initial_agent_mode: profile.initial_agent_mode ?? null,
    codex_executable_identity: codexReceiptIdentity(codexIdentity),
    node_executable_identity: nodeReceiptIdentity(nodeIdentity),
    resume_status: resumeStatus,
  }
  validateReceiptValue(value)
  return value
}

async function persistOperationReceipt(fields) {
  if (fields.operationOutcome === 'succeeded' && fields.performedOperation === 'load') {
    receiptFailure('correlation')
    if (!fields.operationTrace?.correlated || fields.operationTrace.response_error) {
      throw Object.assign(new Error('successful session/load lacks an exact correlated response witness'), { code: 'receipt_correlation_failed' })
    }
  }
  const value = receiptRecordFor(fields)
  recordTestStage('receipt-commit-start')
  // A visible receipt without a commitment envelope is indeterminate. On a
  // retry, re-prove the exact receipt bytes and namespace durability before
  // promoting those bytes with a new no-replace commitment envelope.
  let visibleReceipt = null
  try {
    visibleReceipt = readReceiptFile(receiptPath)
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
  }
  if (visibleReceipt) {
    fsyncReceiptFile(receiptPath)
    receiptFailure('directory_fsync')
    fsyncDirectory(receiptsDir)
    receiptFailure('readback')
    const reread = readReceiptFile(receiptPath, visibleReceipt.digest)
    if (reread.raw !== visibleReceipt.raw) throw new Error('receipt bytes changed during retry durability proof')
  }
  const committed = exclusiveReceiptCommit(value)
  receiptRecord = committed.value
  receiptDigest = committed.digest
  recordTestStage('receipt-committed')
  meaningfulProgress('receipt_commit', { label: 'receipt committed' })
  if (process.env.ACP_TEST_RECEIPT_COMMIT_DELAY_MS) {
    const delay = nonNegativeNumber(process.env.ACP_TEST_RECEIPT_COMMIT_DELAY_MS)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 5000)))
  }
  await new Promise((resolve) => setImmediate(resolve))
  writeDispatchRecord({ required: receiptRequired })
  return receiptDigest
}

async function tryPersistOperationReceipt(fields) {
  try {
    return await persistOperationReceipt(fields)
  } catch (cause) {
    noteError(cause)
    persistReceiptFailureDiagnostic(cause)
    receiptDigest = null
    if (receiptRequired) throw Object.assign(new Error(`ACP session receipt persistence failed: ${cause.message}`), {
      code: 'receipt_persistence_failed',
      cause,
    })
    console.error(`[warn] could not persist ACP session receipt: ${boundedText(cause.message, 'receipt write failed', MAX_ERROR_TEXT)}`)
    return null
  }
}

function gitValue(args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return result.status === 0 ? result.stdout.trim() : null
}

// Capture mechanical facts once at the settlement decision boundary. The
// resulting record is immutable so later reap/timer bookkeeping cannot rewrite
// the outcome or its KMS provenance. PM verdicts remain separate events.
function captureSettlementRecord(reaped = {}, { timedOut = false, reason = cancellationReason } = {}) {
  const closeResult = reaped.closeResult ?? agentCloseResult ?? unexpectedExit ?? {}
  const record = {
    timed_out: Boolean(timedOut),
    cancellation_reason: boundedText(reason, 'unknown', MAX_TERMINATION_REASON),
    cancellation_unavailable: Boolean(cancellationUnavailable),
    cancel_attempted: Boolean(cancellationAttempted),
    cancel_ack: Boolean(cancellationAck),
    termination_attempted: Boolean(terminationAttempted),
    termination_delivered: Boolean(terminationDelivered),
    kill_attempted: Boolean(killAttempted),
    kill_delivered: Boolean(killDelivered),
    child_settlement_signal_delivered: Boolean(
      reaped.childSettlementSignalDelivered ?? (childSettlementSignalDelivered || terminationDelivered || killDelivered),
    ),
    descendant_cleanup_signal_delivered: Boolean(
      reaped.descendantCleanupSignalDelivered ?? descendantCleanupSignalDelivered,
    ),
    // Tri-state, not a boolean defaulting to false: a caller that never ran
    // `closeAndReapChild` (or an older shape of its return value) genuinely
    // does not know whether the group is gone, and reporting that as `false`
    // would read as a confirmed survivor rather than as unmeasured — the
    // house rule is that a branch that cannot answer says UNKNOWN, not "no".
    descendant_group_gone: reaped.groupGone === undefined ? null : Boolean(reaped.groupGone),
    child_exit_code: Number.isInteger(closeResult.code) ? closeResult.code : null,
    child_signal: closeResult.signal ? boundedText(closeResult.signal, 'unknown', MAX_TEXT) : null,
    forced_reap_attempted: Boolean(reaped.forcedReapAttempted ?? forcedReapAttempted),
    forced_reap_delivered: Boolean(reaped.forcedReapDelivered ?? forcedReapDelivered),
    forced_reap: Boolean(reaped.forced ?? false),
    controller_interrupted: Boolean(controllerInterrupted),
    controller_signal: controllerSignal ? boundedText(controllerSignal, 'unknown', MAX_TEXT) : null,
    controller_signal_count: Math.max(0, Math.min(2, controllerSignalCount)),
    controller_second_signal: controllerSecondSignal ? boundedText(controllerSecondSignal, 'unknown', MAX_TEXT) : null,
  }
  return Object.freeze(record)
}

// Mechanical facts only. PM verdicts remain separate immutable KMS events.
function settlementFacts(settlement) {
  if (!settlement || !Object.isFrozen(settlement)) throw new Error('terminal settlement facts were not captured immutably')
  return {
    cancel_attempted: settlement.cancel_attempted,
    cancel_ack: settlement.cancel_ack,
    termination_attempted: settlement.termination_attempted,
    termination_delivered: settlement.termination_delivered,
    kill_attempted: settlement.kill_attempted,
    kill_delivered: settlement.kill_delivered,
    child_settlement_signal_delivered: settlement.child_settlement_signal_delivered,
    descendant_cleanup_signal_delivered: settlement.descendant_cleanup_signal_delivered,
    descendant_group_gone: settlement.descendant_group_gone,
    child_exit_code: settlement.child_exit_code,
    child_signal: settlement.child_signal,
    forced_reap_attempted: settlement.forced_reap_attempted,
    forced_reap_delivered: settlement.forced_reap_delivered,
    forced_reap: settlement.forced_reap,
    controller_interrupted: settlement.controller_interrupted,
    controller_signal: settlement.controller_signal,
    controller_signal_count: settlement.controller_signal_count,
    controller_second_signal: settlement.controller_second_signal,
  }
}

function recordTerminal(terminal, {
  timedOut = false,
  evidencePresent = false,
  exitCode = -1,
  settlement = null,
  livenessPersistenceFailed = false,
  outboxDigest = null,
} = {}) {
  if (process.env.ACP_KMS_AUTO === '0' || kmsRecorded) return
  kmsRecorded = true
  // The token leaves this agent's hands here. Whether the next team accepts it
  // is their verdict to record, not ours to assume.
  //
  // `outbox_digest` is what makes the verdict this process classified the same
  // fact the runner harvests. Without it each side opened the path separately,
  // and bytes that read `reject` here could read `accept` by the next tick with
  // nothing in the history able to say they had changed.
  appendWorkItemEvent('delivered', {
    terminal,
    timed_out: timedOut,
    evidence_present: evidencePresent,
    // GitHub #45 part 2 (ข้อ 4.10): the one positive fact that lets a reader with
    // only the ledger tell "the model was never asked to do anything" from "the
    // worker tried and failed" — see `workObserved`'s own comment above for what
    // sets it and why the classification defaults toward counting.
    work_observed: workObserved,
    ...(outboxDigest ? { outbox_digest: outboxDigest } : {}),
  })
  const facts = settlementFacts(settlement)
  const rev = gitValue(['rev-parse', '--short', 'HEAD']) ?? 'not-a-git-repo'
  const porcelain = gitValue(['status', '--porcelain'])
  const tree = porcelain === null ? 'unknown' : porcelain ? 'dirty' : 'clean'
  const body = [
    'event_kind: transport-terminal',
    `dispatch_id: ${boundedText(dispatchId, 'unknown', MAX_DISPATCH_ID)}`,
    `task_id: ${taskId}`,
    `worker: ${boundedText(agentName, 'unknown', MAX_WORKER)}`,
    ...(agentId ? [`agent_id: ${boundedText(agentId, '', MAX_WORKER)}`] : []),
    'transport: acp',
    `repo_rev: ${boundedText(rev, 'unknown', MAX_TEXT)}`,
    `tree: ${boundedText(tree, 'unknown', MAX_TEXT)}`,
    `terminal: ${boundedText(terminal, 'unknown', MAX_TERMINATION_REASON)}`,
    `exit_code: ${exitCode}`,
    `child_exit_code: ${facts.child_exit_code ?? 'none'}`,
    `child_signal: ${facts.child_signal ?? 'none'}`,
    `cancel_attempted: ${facts.cancel_attempted}`,
    `cancel_ack: ${facts.cancel_ack}`,
    `termination_attempted: ${facts.termination_attempted}`,
    `termination_delivered: ${facts.termination_delivered}`,
    `kill_attempted: ${facts.kill_attempted}`,
    `kill_delivered: ${facts.kill_delivered}`,
    `child_settlement_signal_delivered: ${facts.child_settlement_signal_delivered}`,
    `descendant_cleanup_signal_delivered: ${facts.descendant_cleanup_signal_delivered}`,
    `descendant_group_gone: ${facts.descendant_group_gone === null ? 'unknown' : facts.descendant_group_gone}`,
    `forced_reap_attempted: ${facts.forced_reap_attempted}`,
    `forced_reap_delivered: ${facts.forced_reap_delivered}`,
    `forced_reap: ${facts.forced_reap}`,
    `controller_interrupted: ${facts.controller_interrupted}`,
    `controller_signal: ${facts.controller_signal ?? 'none'}`,
    `controller_signal_count: ${facts.controller_signal_count}`,
    `controller_second_signal: ${facts.controller_second_signal ?? 'none'}`,
    `controller_signal_provenance_durable: ${firstSignalProvenanceDurable}`,
    `initialize_agent_info: ${operationContext.initializeTrace?.observed_agent_info ? stableJson(operationContext.initializeTrace.observed_agent_info) : 'none'}`,
    `liveness_persistence_failed: ${livenessPersistenceFailed}`,
    `receipt_digest: ${receiptDigest ?? 'none'}`,
    `receipt_persistence_failed: ${terminationReason === 'receipt_persistence_failed'}`,
    `started_at: ${persistedTimestamp(startedAt)}`,
    `wait_sec: ${Math.max(0, Math.round((Date.now() - startedMs) / 1000))}`,
    `stall_sec: ${stallSec}`,
    `timeout_sec: ${stallSec}`,
    `hard_timeout_sec: ${hardTimeoutSec}`,
    `stall_policy: ${stallPolicy}`,
    `termination_reason: ${boundedText(terminationReason, 'unknown', MAX_TERMINATION_REASON)}`,
    `liveness_state: ${livenessState}`,
    `session_id: ${persistedSessionId(activeSessionId) || 'none'}`,
    `active_tools: ${JSON.stringify(currentActiveToolEvidence())}`,
    `requested_model: ${boundedText(requestedModel, 'none', MAX_MODEL)}`,
    `requested_reasoning_effort: ${boundedText(requestedReasoningEffort, 'none', MAX_REASONING_EFFORT)}`,
    `effective_identity: ${boundedText(identity.effectiveIdentity, 'missing', MAX_MODEL + MAX_REASONING_EFFORT + 2)}`,
    `identity_status: ${boundedText(identity.status, 'unverified', MAX_TEXT)}`,
    `error: ${boundedText(lastErrorText || stderrBuf, 'none', MAX_ERROR_TEXT)}`,
    `brief_bytes: ${Buffer.byteLength(brief)}`,
    `evidence_present: ${evidencePresent}`,
    `outbox_digest: ${outboxDigest ?? 'none'}`,
    `timed_out: ${timedOut}`,
  ].join('\n') + '\n'
  const result = spawnSync(process.execPath, [KMS, 'append', cwd, '-'], {
    encoding: 'utf8',
    input: body,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status === 0) console.error(`[kms] recorded ${result.stdout.trim()}`)
  else console.error(`[warn] could not record KMS terminal event: ${boundedText(result.stderr || result.error?.message || `exit ${result.status}`, `exit ${result.status}`, MAX_ERROR_TEXT)}`)
}

function hasEvidence(text) {
  const chunks = []
  let inside = false
  for (const line of String(text).split(/\r?\n/)) {
    if (!inside) {
      const match = line.match(/^EVIDENCE:[ \t]*(.*)$/)
      if (!match) continue
      inside = true
      if (match[1]) chunks.push(match[1])
      continue
    }
    if (/^TEAM_(DONE|BLOCKED|FAILED)\b/.test(line) || /^[A-Z][A-Z0-9 _-]*:[ \t]*/.test(line)) break
    chunks.push(line)
  }
  const evidence = chunks.join('\n').trim()
  return !!evidence && !/^(?:ok|yes|pass(?:ed)?|none|n\/a|✓)$/i.test(evidence)
}

// Kept as a named no-op call site rather than deleted at every caller: the
// terminal evidence it forwarded went to the phase-gate store, and nothing
// consumes that now. The KMS event and the work-item ledger already carry the
// same facts.
function recordGovernedTerminalSafely() {}

const preamble =
  `Your task-id is ${taskId}. Write your outbox to .mailbox-out/${taskId} — ` +
  'a single flat FILE (do NOT create it as a directory). Its last line must be exactly: ' +
  `TEAM_DONE ${taskId} (or TEAM_BLOCKED ${taskId} / TEAM_FAILED ${taskId}).\n\n---\n\n`

const CMDS = {
  claude: ['npx', ['-y', '@agentclientprotocol/claude-agent-acp']],
  codex: ['npx', ['-y', CODEX_ADAPTER_PACKAGE_SPEC]],
  agy: ['bunx', ['antigravity-acp@1.0.0']],
}
let cmd
if (process.env.ACP_CMD) {
  cmd = parseCommand(process.env.ACP_CMD)
} else if (CMDS[agentName]) {
  cmd = CMDS[agentName]
} else {
  console.error(`unknown agent "${agentName}" — use claude|codex|agy or set ACP_CMD`)
  process.exit(2)
}

try {
  adapterProfile = configureExecutionProfile(cmd)
  if (receiptRequired && process.env.ACP_CMD && stableJson(adapterProfile.argv) !== stableJson([cmd[0], ...cmd[1]])) {
    throw Object.assign(new Error('required ACP command does not match its closed execution profile'), { code: 'execution_profile_drift' })
  }
  // The verified profile is the command that is actually spawned. Keeping the
  // original textual ACP_CMD out of this boundary prevents PATH/npm lookup
  // from changing the executable after attestation.
  cmd = [adapterProfile.argv[0], adapterProfile.argv.slice(1)]
} catch (cause) {
  console.error(`[receipt] ${cause.code ?? 'EXECUTION_PROFILE_INVALID'}: ${cause.message}`)
  try {
    flushPersistence()
    await persistFailureReceiptIfNeeded(cause)
  } catch (evidenceCause) {
    console.error(`[receipt] failure tombstone unavailable: ${boundedText(evidenceCause.message, 'receipt failure', MAX_ERROR_TEXT)}`)
  }
  process.exit(2)
}
try {
  priorReceipt = priorReceiptForLoad()
} catch (cause) {
  console.error(`[receipt] prior lineage validation failed: ${cause.message}`)
  try {
    flushPersistence()
    await persistFailureReceiptIfNeeded(cause)
  } catch (evidenceCause) {
    console.error(`[receipt] failure tombstone unavailable: ${boundedText(evidenceCause.message, 'receipt failure', MAX_ERROR_TEXT)}`)
  }
  process.exit(2)
}

// The adapter used to inherit this process's entire environment, so an adapter
// that was wrong — or taken — saw every credential the parent was carrying,
// including the ones belonging to other lanes. It now gets what its own lane
// needs and nothing else.
//
// The lists are deliberately generous rather than minimal: the failure mode of
// a missing variable is a lane that stops working for a reason nobody can see,
// which is worse than the leak this closes. ACP_ENV_PASSTHROUGH names anything
// an operator finds missing, so a gap is a one-line fix and never a reason to
// go back to inheriting everything.
const RUNTIME_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT',
  'WINDIR', 'COMSPEC', 'PATHEXT', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'NODE_PATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'BUN_INSTALL',
  // Protocol and harness, not credentials: INITIAL_AGENT_MODE is the ACP mode
  // this companion negotiates, and ECC_GATEGUARD is how a dispatch stops this
  // machine's own hooks from firing inside a worker that cannot answer them.
  'INITIAL_AGENT_MODE', 'ECC_GATEGUARD', 'ECC_DISABLED_HOOKS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
])
// Only the lane being spawned. A Codex adapter has no business seeing an
// Anthropic key, and the kimi wiring in this repo proves the reverse matters:
// ANTHROPIC_BASE_URL alone redirects the claude lane at another vendor.
const LANE_ENV_KEYS = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR',
    // Added 2026-08-13 after a review lane died on
    // `Claude's response exceeded the 32000 output token maximum`, whose own
    // error text names this variable as the fix. It was not on this list, so
    // the companion stripped it: the documented remedy could not be reached
    // through the documented dispatch path. Setting it changes nothing on its
    // own — an operator who does not set it sees exactly the behaviour they saw
    // before.
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_SIMPLE'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'CODEX_PATH'],
  // VERIFIED 2026-08-04, and the clause that stood here before that date was
  // false: it said the gemini lane "has been dead since 2026-07-21" and "has
  // never been run", which nothing had compared against a run. It ran — twice,
  // through this exact allowlist, returning full reviews in the retro-release
  // rounds. `claude` and `codex` were dispatched end to end on 2026-08-02.
  // The row is still the narrow one antigravity-acp happened to need; whoever
  // adds a variable should expect to add here too.
  // AGY_EXTRA_ARGS is the adapter's own knob (antigravity-acp reads it into
  // the agy argv, e.g. `--dangerously-skip-permissions` for headless dispatch
  // where no one can answer a permission prompt); without it here the knob
  // dies at this allowlist and the operator's only route is
  // ACP_ENV_PASSTHROUGH.
  agy: ['AGY_API_KEY', 'AGY_BIN', 'AGY_EXTRA_ARGS', 'AGY_SKIP_DOWNLOAD',
    'ANTIGRAVITY_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
}
// `ACP_` and `TMUX_TEAMS_` are this system talking to itself. `MOCK_` belongs to
// the bundled fixture agent and is named here rather than smuggled in through a
// wildcard, so it is visible that a test seam exists and exactly how wide it is.
const ENV_PREFIXES = ['ACP_', 'TMUX_TEAMS_', 'MOCK_', 'npm_config_', 'NPM_CONFIG_']

function adapterEnv(lane, source = process.env) {
  const extra = new Set((source.ACP_ENV_PASSTHROUGH ?? '').split(',').map((name) => name.trim()).filter(Boolean))
  const lanes = new Set(LANE_ENV_KEYS[lane] ?? [])
  const allowed = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (RUNTIME_ENV_KEYS.has(key) || lanes.has(key) || extra.has(key)
      || ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      allowed[key] = value
    }
  }
  return allowed
}

// GitHub #58: a worker spawned here is a BUILD AGENT, not a continuation of
// whoever's terminal started the loop — and it was inheriting both halves of
// that terminal. The target repo's `.claude/settings.json` fired its
// `UserPromptSubmit` hooks inside the worker (in this very repo that hook
// injects a party-mode persona, so a worker spent minutes playing character
// voices and made zero tool calls), and the operator's own
// `~/.claude/settings.json` `defaultMode: plan` started it in plan mode, where
// it thought 442 times and executed nothing.
//
// `CLAUDE_CODE_SIMPLE=1` is what `claude --bare` sets, and it is the lever this
// process can actually reach: the ACP adapter spawns the CLI itself, so its
// argv is not ours, but the child environment is. Measured rather than read off
// the help text — a project hook writing a marker file fired on a plain run and
// did not fire with this set.
//
// It is a DEFAULT, not a lock: `ACP_INHERIT_PROJECT_CONFIG=1` restores the old
// behaviour for anyone who genuinely wants a worker to see the repo's hooks.
//
// And it turns off MORE than hooks, which a release reviewer named and the
// first version of this comment did not: bare mode also drops the project's MCP
// servers, its `.claude/commands/`, and its `.claude/settings.json` permissions.
// For a delivery worker that is the point — those are the operator's tools, not
// the build's — but a repo whose workers genuinely need a project MCP server has
// to set `ACP_INHERIT_PROJECT_CONFIG=1` and take the hooks back with it. That is
// a real trade and it belongs here rather than in a surprise.
// The plan-mode half is not fixed here — that lives in the operator's user
// settings, and the way out is an isolated `CLAUDE_CONFIG_DIR` for the worker
// profile, which several already use.
const spawnEnv = {
  ...adapterEnv(agentName),
  ...(agentName === 'claude' && process.env.ACP_INHERIT_PROJECT_CONFIG !== '1'
    ? { CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE ?? '1' } : {}),
  ...(agentName === 'agy' ? { AGY_SKIP_DOWNLOAD: process.env.AGY_SKIP_DOWNLOAD ?? '1' } : {}),
  ...(agentName === 'codex' ? { INITIAL_AGENT_MODE: effectiveInitialAgentMode } : {}),
}

// Create the initial immutable-ish footprint before spawn for the ungated lane;
// all later rewrites use the same-directory atomic writer and carry only bounded
// metadata plus the liveness SSOT path.
flushPersistence()

let agent
function interruptionError(stage) {
  return Object.assign(new Error(`controller interrupted before ${stage}`), { code: 'controller_interrupted' })
}

function assertProtocolFence(stage, allowAfterInterruption = false) {
  if (controllerInterrupted && !allowAfterInterruption) throw interruptionError(stage)
}

function receiveControllerSignal(signal) {
  if (terminalRecorded) return
  controllerSignalCount += 1
  if (!controllerInterrupted) {
    controllerInterrupted = true
    controllerSignal = signal
    setTerminationReason('controller_interrupted')
    console.error(`[controller] ${signal} latched; no new ACP protocol call may begin`)
    recordTestStage('controller-signal-latched')
    firstSignalProvenanceDurable = persistControllerSignalProvenance()
    recordTestStage(firstSignalProvenanceDurable ? 'controller-signal-durable' : 'controller-signal-persistence-unavailable')
  } else {
    controllerSecondSignal = signal
    console.error(`[controller] second signal ${signal} latched; escalating deterministically`)
    recordTestStage('controller-second-signal-latched')
    if (!firstSignalProvenanceDurable) firstSignalProvenanceDurable = persistControllerSignalProvenance()
  }
  appendControlEvent(`controller signal ${signal}`)
  if (agent && !cancellationActive && !cancellationFinalized) beginCancellation('controller_interrupted', 'cancelled')
  if (agent && controllerSignalCount > 1) {
    if (firstSignalProvenanceDurable) sendTerminationSignal('SIGKILL')
    else pendingSecondSignal = true
  }
  if (firstSignalProvenanceDurable && pendingSecondSignal) {
    pendingSecondSignal = false
    sendTerminationSignal('SIGKILL')
  }
}

const controllerSignalHandlers = new Map()
for (const signal of ['SIGINT', 'SIGTERM']) {
  const handler = () => receiveControllerSignal(signal)
  controllerSignalHandlers.set(signal, handler)
  process.on(signal, handler)
}
controllerSignalHandlerInstalled = true
try {
  agent = spawn(cmd[0], cmd[1], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: spawnEnv,
  })
} catch (cause) {
  console.error(`[fatal] cannot spawn ${cmd[0]}: ${cause.message}`)
  process.exit(1)
}

if (controllerInterrupted && !cancellationActive) beginCancellation('controller_interrupted', 'cancelled')

const childClosedPromise = new Promise((resolve) => {
  agent.once('close', (code, signal) => {
    agentClosed = true
    agentCloseResult = { code, signal }
    resolve(agentCloseResult)
  })
})
const childExitedPromise = new Promise((resolve) => {
  agent.once('exit', (code, signal) => {
    agentExitResult = { code, signal }
    resolve(agentExitResult)
  })
})

function appendControlEvent(text) {
  const path = process.env.ACP_CONTROL_LOG
  if (!path) return
  try { appendFileSync(path, `${text}\n`, { mode: 0o600 }) } catch {}
}

function persistControllerSignalProvenance() {
  if (process.env.ACP_TEST_CONTROLLER_SIGNAL_PERSISTENCE_FAILURE === '1') return false
  try {
    ensureStoreIgnore()
    mkdirSync(controllerSignalsDir, { recursive: false })
  } catch (cause) {
    if (cause.code !== 'EEXIST') return false
  }
  const value = {
    schema: 'acp-controller-signal.v1',
    task_id: taskId,
    dispatch_id: dispatchId,
    first_signal: controllerSignal,
    signal_count: Math.min(2, controllerSignalCount),
    second_signal: controllerSecondSignal,
    durable: true,
  }
  const raw = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_BYTES) return false
  try {
    atomicWrite(controllerSignalPath, raw)
    const readback = readFileSync(controllerSignalPath, 'utf8')
    if (readback !== raw || JSON.parse(readback).dispatch_id !== dispatchId) return false
    return true
  } catch {
    return false
  }
}

function recordTestStage(stage) {
  if (!/^[a-z0-9_.:-]{1,96}$/.test(stage)) return
  const path = process.env.ACP_TEST_STAGE_FILE
  if (!path) return
  try { appendFileSync(path, `${stage}\n`, { mode: 0o600 }) } catch {}
}

async function waitForTestGate(stage) {
  if (process.env.ACP_TEST_GATE_STAGE !== stage || !process.env.ACP_TEST_GATE_RELEASE_FILE) return
  recordTestStage(`${stage}-reached`)
  const watchdogMs = Math.min(60_000, Math.max(100, nonNegativeNumber(process.env.ACP_TEST_GATE_WATCHDOG_MS, 15_000)))
  const deadline = Date.now() + watchdogMs
  while (!existsSync(process.env.ACP_TEST_GATE_RELEASE_FILE)) {
    if (Date.now() >= deadline) throw Object.assign(new Error(`test gate ${stage} watchdog expired`), { code: 'test_gate_timeout' })
    await waitFor(10)
  }
  recordTestStage(`${stage}-released`)
}

// `phase` names which ladder delivered the signal. The receipt has kept
// child-settlement and descendant-only cleanup in separate fields all along
// (README: "keeps … descendant-only cleanup delivery separate"), but the control
// log wrote one identical line for both, so nothing reading it could tell a
// cancellation from a post-settlement sweep. A test then required the `grace`
// step in front of every delivered signal — impossible for a sweep, whose child
// is already gone — and failed on a clean tree at v0.13.1.
function signalProcessGroup(signal, phase = 'cancel') {
  const result = { delivered: false, childDelivered: false }
  if (!agent?.pid || agent.pid <= 0) return result
  const note = (target) => appendControlEvent(`signal ${signal} ${target} delivered (${phase})`)
  // A successful direct child kill is the only positive child-settlement
  // signal fact. A process-group kill can succeed solely because a descendant
  // remains after the child has already exited.
  try {
    process.kill(agent.pid, signal)
    result.delivered = true
    result.childDelivered = true
    note('direct-child')
  } catch {}
  try {
    process.kill(-agent.pid, signal)
    result.delivered = true
    note('process-group')
  } catch {
    for (const pid of groupPids(agent.pid)) {
      try {
        process.kill(pid, signal)
        result.delivered = true
        if (pid === agent.pid) result.childDelivered = true
        note(pid === agent.pid ? 'direct-child' : 'process-group')
      } catch {}
    }
    try {
      if (agent.kill(signal)) {
        result.delivered = true
        result.childDelivered = true
        note('direct-child')
      }
    } catch {}
  }
  return result
}

// One `ps` line per process, `pid pgid`. macOS and the BSDs have no /proc, and
// answering "who else is in this group" with an empty list there is not an
// unknown — it reads as NOBODY, which is what silently turned both descendant
// sweeps below into no-ops and left an orphan behind every cancellation.
// pulse.mjs already answers its own liveness questions this way.
function parseGroupPids(text, groupId) {
  const members = []
  for (const line of String(text).split('\n')) {
    const [pid, pgid] = line.trim().split(/\s+/)
    if (Number(pgid) === Number(groupId) && /^\d+$/.test(pid)) members.push(Number(pid))
  }
  return members
}

function groupPids(groupId) {
  if (!groupId) return []
  if (process.platform !== 'linux') {
    const result = spawnSync('ps', ['-Ao', 'pid=,pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return result.status === 0 && typeof result.stdout === 'string'
      ? parseGroupPids(result.stdout, groupId)
      : []
  }
  let entries
  try { entries = readdirSync('/proc') } catch { return [] }
  const members = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const statText = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const afterComm = statText.slice(statText.lastIndexOf(')') + 2).split(' ')
      if (Number(afterComm[2]) === Number(groupId)) members.push(Number(entry))
    } catch {}
  }
  return members
}

async function waitFor(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForChildClose(timeoutMs) {
  if (agentClosed) return agentCloseResult
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs))
  })
  const result = await Promise.race([childClosedPromise, childExitedPromise, timeout])
  if (timer) clearTimeout(timer)
  return result
}

// `kill(-pgid, 0)` is POSIX and answers this everywhere: it fails only when no
// process in the group is left. Returning true unplaced on anything but Linux
// declared the group reaped without looking, so the escalation below — the last
// thing that would have signalled a surviving descendant — never ran once.
// `groupId` is a parameter rather than reading `agent?.pid` directly so the
// terminal capability's own reap ladder (`reapTerminalGroup`) can reuse this
// exact wait instead of a second copy scoped only to `agent`.
async function waitForGroupGone(groupId, timeoutMs = 1000) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() <= deadline) {
    let groupExists = false
    if (groupId) {
      try { process.kill(-groupId, 0); groupExists = true } catch {}
    }
    if (!groupExists && groupPids(groupId).length === 0) return true
    await waitFor(20)
  }
  try { process.kill(-groupId, 0); return false } catch {}
  return groupPids(groupId).length === 0
}

async function closeAndReapChild({ signalIfNeeded = true, closeGraceMs = processKillGraceMs } = {}) {
  if (!agentClosed) {
    try { agent.stdin.end() } catch {}
  }
  let closeResult = await waitForChildClose(closeGraceMs)
  let forcedAttempted = false
  let forcedDelivered = false
  let descendantCleanupDelivered = false
  const reapSignal = (signal, message) => {
    forcedAttempted = true
    forcedReapAttempted = true
    appendControlEvent(`signal ${signal} (reap)`)
    console.error(message)
    const childSettledBeforeSignal = Boolean(agentClosed || agentExitResult)
    const signalResult = signalProcessGroup(signal, 'reap')
    if (signalResult.delivered) {
      forcedReapDelivered = true
      if (signalResult.childDelivered && !childSettledBeforeSignal) {
        forcedDelivered = true
        childSettlementSignalDelivered = true
      } else {
        descendantCleanupDelivered = true
        descendantCleanupSignalDelivered = true
      }
    }
    return signalResult.delivered
  }
  if (!closeResult && signalIfNeeded) {
    reapSignal('SIGTERM', '[reap] signal SIGTERM')
    closeResult = await waitForChildClose(processKillGraceMs)
    if (!closeResult) {
      reapSignal('SIGKILL', '[reap] signal SIGKILL')
      closeResult = await waitForChildClose(processKillGraceMs)
    }
  }
  if (closeResult && signalIfNeeded && groupPids(agent?.pid).some((pid) => pid !== agent?.pid)) {
    reapSignal('SIGTERM', '[reap] signal SIGTERM for descendants after child settlement')
  }
  let groupGone = await waitForGroupGone(agent?.pid, Math.max(processReapGraceMs, processKillGraceMs * 2))
  if (!groupGone && signalIfNeeded) {
    reapSignal('SIGTERM', '[reap] signal SIGTERM for remaining process group')
    groupGone = await waitForGroupGone(agent?.pid, processKillGraceMs)
    if (!groupGone) {
      reapSignal('SIGKILL', '[reap] signal SIGKILL for remaining process group')
      groupGone = await waitForGroupGone(agent?.pid, processKillGraceMs)
    }
  }
  return {
    closeResult: closeResult ?? agentCloseResult ?? null,
    forced: forcedDelivered,
    forcedReapAttempted: forcedAttempted,
    forcedReapDelivered,
    descendantCleanupSignalDelivered: descendantCleanupDelivered || descendantCleanupSignalDelivered,
    childSettlementSignalDelivered: childSettlementSignalDelivered,
    // This function computes `groupGone` above and, until now, threw the fact
    // away here: every caller persisted a terminal state with no way to tell
    // a truly reaped process group from one that outlived every TERM/KILL
    // sweep. "The caller cannot distinguish a reaped group from a surviving
    // one" was the exact defect — the receipt now carries the computed value
    // instead of silently discarding it.
    groupGone,
  }
}

function codexGuard(text) {
  if (/unknown variant `ultra`/.test(text) || /requires a newer version of Codex/.test(text)) {
    console.error(
      '[codex-acp guard] this failure signature means a DEPRECATED zed-industries codex-acp ' +
      'build (stale embedded core) handled the session. Use the official App Server adapter ' +
      'instead — `npx -y @agentclientprotocol/codex-acp` (the default here).',
    )
  }
}

let nextId = 1
const pending = new Map()
function rejectPending(cause) {
  for (const [id, entry] of pending.entries()) {
    pending.delete(id)
    entry.reject(cause)
  }
}

function request(method, params, { trace = null, allowAfterInterruption = false } = {}) {
  assertProtocolFence(method, allowAfterInterruption)
  const id = nextId++
  const message = { jsonrpc: '2.0', id, method, params }
  if (trace) {
    trace.id = id
    trace.request_digest = sha256Text(stableJson(message))
    trace.correlated = false
    trace.response_error = false
  }
  return new Promise((resolve, reject) => {
    if (agentClosed) {
      reject(new Error(`ACP child closed before ${method}`))
      return
    }
    pending.set(id, { resolve, reject, method, trace })
    try {
      agent.stdin.write(`${JSON.stringify(message)}\n`)
      recordTestStage(`request-${method.replaceAll('/', '-')}-sent`)
    } catch (cause) {
      pending.delete(id)
      reject(cause)
    }
  })
}

function respond(id, result) {
  try { agent.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`) } catch {}
}

function respondError(id, code, message) {
  try { agent.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`) } catch {}
}

// ACP terminal/* — the methods `clientCapabilities.terminal: true` promises.
// RULE: this is the one path that can actually grant a terminal, so it is
// where "not enabled" is enforced, not only at `initialize`. An unadvertised
// capability is a request a spec-conforming adapter should never send, but a
// request that arrives anyway must still be refused HERE — a policy stated
// only in what we advertise and never checked where it is served is not a
// policy, it is a hope.
const terminals = new Map() // terminalId -> term record, see createTerminal
let terminalStdinBridgeInstalled = false

function truncateToByteLimit(text, limit) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= limit) return text
  let start = buf.length - limit
  // TRAP: slicing a UTF-8 buffer at an arbitrary byte offset can land inside
  // a multi-byte character. Walk forward past any continuation byte
  // (10xxxxxx) so the kept tail always starts on a character boundary, same
  // requirement the ACP spec states for this field.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1
  return buf.subarray(start).toString('utf8')
}

function appendTerminalOutput(term, text) {
  term.outputText += text
  if (Buffer.byteLength(term.outputText, 'utf8') > term.outputByteLimit) {
    term.truncated = true
    term.outputText = truncateToByteLimit(term.outputText, term.outputByteLimit)
  }
}

function settleTerminalExit(term, status) {
  if (term.exitStatus) return
  term.exitStatus = status
  const waiters = term.waiters
  term.waiters = []
  for (const resolve of waiters) resolve(status)
  // A released-but-still-alive terminal is removed HERE, once it actually
  // exits — not at release time. See releaseTerminal for why: removing it
  // immediately took it out of killAllLiveTerminals' teardown sweep while the
  // child could still be alive and ignoring the SIGTERM release itself sent.
  //
  // `released` alone is not enough: it says the wrapper's OWN exit settled,
  // not that the whole process GROUP is gone. A wrapper that forked a plain
  // (non-detached) descendant before dying — one that traps SIGTERM, or was
  // never reached by release's own signal because release ran while the
  // wrapper was still alive and only the wrapper died from it — leaves that
  // descendant sharing the same pgid and still alive right here. Deleting on
  // `released` alone would drop it from `terminals` before
  // killAllLiveTerminals' teardown sweep ever runs, orphaning it permanently.
  // Keeping the entry when the group is not yet gone costs nothing: it is
  // still reaped as soon as `isGroupGone` says so, either by a later call
  // here (it won't fire again for this wrapper) or, in practice, by the
  // teardown sweep itself — `reapTerminalGroup`'s own `isGroupGone` check
  // makes that a no-op the moment this becomes true on its own.
  if (term.released && isGroupGone(term.child?.pid)) terminals.delete(term.terminalId)
}

// Only login mode ever reads the companion's OWN stdin — ordinary dispatch
// never does, so this is never wired up unless a terminal actually exists.
// Broadcast to every open terminal rather than routing per-terminal: a login
// run drives one interactive command at a time, and createTerminal now
// ENFORCES that instead of merely assuming it — a second `terminal/create`
// while one is still live is refused there. With at most one live terminal,
// this loop broadcasting to "every open terminal" is provably a unicast, not
// a hope; building session-aware input routing for a case that cannot occur
// would only be guessing at a requirement nobody has.
function ensureTerminalStdinBridge() {
  if (terminalStdinBridgeInstalled) return
  terminalStdinBridgeInstalled = true
  // The companion's own stdin is a stream too, and in login mode it is resumed.
  process.stdin.on('error', () => {})
  process.stdin.on('data', (chunk) => {
    for (const term of terminals.values()) {
      if (term.exitStatus || term.released) continue
      try { term.child.stdin.write(chunk) } catch {}
    }
  })
  // EOF has to travel too. A login command that reads until end-of-input — or an
  // operator pressing Ctrl-D, or a finite pipe running dry — would otherwise sit
  // blocked forever while `terminal/wait_for_exit` and the whole ACP turn hang,
  // because the bridge forwarded every keystroke and never the end of them.
  const closeTerminalInput = () => {
    for (const term of terminals.values()) {
      if (term.exitStatus || term.released) continue
      try { term.child.stdin.end() } catch {}
    }
  }
  // One listener, and no catch-up for an already-ended stdin. That catch-up was
  // written here on the reasoning that a finite pipe could end before the first
  // terminal exists — and then deleting it left the EOF test GREEN while
  // deleting both turned it red at the 30s kill. It defends a case nobody could
  // produce, which in this file is not a guard.
  process.stdin.on('end', closeTerminalInput)
  process.stdin.resume()
  // TRAP: this file ends in `process.exitCode = exitCode`, not
  // `process.exit(...)` — it relies on the event loop draining once every
  // handle closes. A resumed TTY never emits 'end' on its own (only Ctrl-D or
  // process exit closes it), so without unref() a real interactive login run
  // would finish the whole ACP exchange and then hang forever instead of
  // exiting with the code it already decided. unref() lets this stream keep
  // delivering keystrokes while anything else holds the loop open, without
  // itself being a reason the loop stays open once nothing else does.
  process.stdin.unref?.()
}

// Decoding a raw child_process pipe chunk with `chunk.toString('utf8')` per
// 'data' event corrupts any multi-byte UTF-8 character whose bytes land in
// two different reads: 0xC3 alone and 0xA9 alone each decode to U+FFFD, where
// the same two bytes decoded together (or via a stateful decoder) produce
// 'é'. Measured directly against this exact split. `StringDecoder` carries
// any trailing incomplete sequence forward to the NEXT `write()` instead of
// discarding it, which is the fix — one decoder per stream (never shared
// between stdout and stderr: those are independent pipes, so a byte sequence
// split across a read always stays within the one stream it came from).
//
// The same per-chunk-arrival problem shows up a second way: mirroring raw
// chunks to stderr put the "[terminal:id] " label wherever a chunk boundary
// happened to fall, including the middle of a URL a human needs to copy
// whole. Line-buffer the mirror so the label only ever starts a line — the
// ACP `terminal/output` field itself (`appendTerminalOutput`, via
// `onDecoded` below) is unaffected, since nothing there requires line
// boundaries.
function attachTerminalOutputStream(term, terminalId, stream) {
  const decoder = new StringDecoder('utf8')
  let mirrorBuffer = ''
  const mirrorLine = (line) => {
    try { process.stderr.write(redact(`[terminal:${terminalId}] ${line}\n`).slice(0, MAX_DISPLAY_TEXT)) } catch {}
  }
  const onDecoded = (text) => {
    if (!text) return
    appendTerminalOutput(term, text)
    // The human at the keyboard is the only reader who can act on a login
    // prompt (a URL to open, a code to paste back). Mirror it live, the same
    // way the ACP adapter's own stderr is already mirrored below, so it
    // actually reaches a screen instead of sitting only in `terminal/output`.
    mirrorBuffer += text
    const lines = mirrorBuffer.split('\n')
    mirrorBuffer = lines.pop() ?? ''
    for (const line of lines) mirrorLine(line)
    // MAX_TERMINAL_OUTPUT_BYTES exists so "a misbehaving or hostile agent
    // cannot make the companion retain unbounded output in memory" — a
    // pending line with no '\n' yet is exactly such unbounded retention if
    // nothing ever bounds it. mirrorLine already slices to MAX_DISPLAY_TEXT,
    // so a pending line already past that cap gains nothing from waiting for
    // its newline; flush it now instead of growing it forever.
    if (mirrorBuffer.length > MAX_DISPLAY_TEXT) {
      mirrorLine(mirrorBuffer)
      mirrorBuffer = ''
    }
  }
  // A stdio Socket emits its OWN 'error'; `child.on('error')` is the ChildProcess
  // and does not cover it, so an unhandled read fault here takes the whole process
  // down. Found on the third pass: two doors were named, a survey of every stream
  // with a 'data' listener and no 'error' listener found seven.
  stream.on('error', () => {})
  stream.on('data', (chunk) => onDecoded(decoder.write(chunk)))
  // Flush at exit: a trailing partial line with no '\n' yet must still reach
  // the operator rather than being silently dropped, and `decoder.end()`
  // resolves whatever incomplete byte sequence the pipe closed on (correctly
  // as U+FFFD if the child genuinely wrote a truncated sequence — that case
  // is real corruption at the source, not this bug).
  return () => {
    onDecoded(decoder.end())
    if (mirrorBuffer) mirrorLine(mirrorBuffer)
    mirrorBuffer = ''
  }
}

function createTerminal(params) {
  const command = typeof params?.command === 'string' && params.command ? params.command : null
  if (!command) throw new Error('terminal/create requires a non-empty command string')
  // A login run drives at most one live terminal at a time — the assumption
  // ensureTerminalStdinBridge's broadcast already relies on. That used to be
  // stated only in a comment and never checked where terminal/create is
  // actually served, which this file's own RULE above says is not a policy,
  // it is a hope: a second `terminal/create` while one is still live would
  // make every future keystroke (including a login code meant for the first
  // command) go to both children, and could corrupt both interactive flows.
  // Refuse it outright rather than building session-aware input routing for
  // a case the comment already says does not occur. A terminal stops being
  // "live" the moment it exits OR is released — same test the stdin bridge
  // itself uses (`term.exitStatus || term.released`) — so a login flow that
  // finishes one command and then opens the next is unaffected.
  const existingLive = [...terminals.values()].find((term) => !term.exitStatus && !term.released)
  if (existingLive) {
    throw new Error(
      `terminal/create refused — a login run drives at most one live terminal at a time `
      + `(terminal ${existingLive.terminalId} is still live)`)
  }
  // Refuse a malformed element rather than silently dropping it (args) or
  // coercing it (env value). A `.filter` here used to spawn `echo a b` for
  // `args: ['a', 1, 'b']` — the caller believing it asked for `echo a 1 b`
  // and getting a different command run instead — and `value: {bad: 1}` used
  // to set the child's env var to the literal string "[object Object]" with
  // no signal that the request was never actually honored. The catch in
  // handleTerminalRequest already maps a thrown error to -32602, so throwing
  // needs no new plumbing.
  // A non-array `args` (e.g. a bare string) used to fall through the ternary
  // below to the `[]` branch just like `undefined` does, silently dropping
  // every argument instead of refusing the malformed shape the element check
  // already refuses one value at a time. `params.args === null` also lands
  // here (typeof null is 'object') — deliberate: null is a present, non-array
  // value, not an absent one, and gets the same refusal as any other.
  //
  // BOTH containers, checked together. The first version of this guard named
  // `args` alone, and `env` one line down had the identical defect —
  // `env: "FOO=1"` fell to `{}` and the caller's whole environment override
  // vanished with no signal. That is the shape this repository keeps finding:
  // a guard written for the container that was REPORTED, with its twin left
  // open beside it. Both are optional arrays; neither may be a present
  // non-array, `null` included.
  for (const key of ['args', 'env']) {
    if (params[key] !== undefined && !Array.isArray(params[key])) {
      throw new Error(`terminal/create ${key} must be an array, got ${typeof params[key]}`)
    }
  }
  const args = Array.isArray(params.args)
    ? params.args.map((value, index) => {
      if (typeof value !== 'string') {
        throw new Error(`terminal/create args[${index}] must be a string, got ${typeof value}`)
      }
      return value
    })
    : []
  const envOverrides = Array.isArray(params.env)
    ? Object.fromEntries(params.env.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
        throw new Error(`terminal/create env[${index}] must be an object with a string name`)
      }
      if (entry.value !== undefined && entry.value !== null && typeof entry.value !== 'string') {
        throw new Error(`terminal/create env[${index}].value must be a string, got ${typeof entry.value}`)
      }
      return [entry.name, entry.value ?? '']
    }))
    : {}
  const terminalCwd = typeof params.cwd === 'string' && params.cwd.trim() ? params.cwd : cwd
  const requestedLimit = Number.isFinite(params.outputByteLimit) && params.outputByteLimit > 0
    ? Number(params.outputByteLimit)
    : DEFAULT_TERMINAL_OUTPUT_BYTES
  const outputByteLimit = Math.max(1, Math.min(requestedLimit, MAX_TERMINAL_OUTPUT_BYTES))

  const terminalId = `term_${randomUUID()}`
  let child
  try {
    // `detached: true` makes this child its OWN process-group leader (its pid
    // doubles as its pgid), same trick the main `agent` child already relies
    // on. A terminal command that is itself a launcher — a shell, npx, bunx,
    // anything that forks — spawns its descendant WITHOUT `detached`, so that
    // descendant inherits THIS group rather than the companion's own. That is
    // what lets `signalTerminalGroup` reach the whole subtree via
    // `process.kill(-pid, …)` instead of only ever touching the wrapper pid.
    child = spawn(command, args, {
      cwd: terminalCwd,
      env: { ...process.env, ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (cause) {
    throw new Error(`cannot spawn terminal command: ${cause.message}`)
  }

  const term = {
    terminalId, child, outputText: '', outputByteLimit,
    truncated: false, exitStatus: null, released: false, waiters: [],
  }
  terminals.set(terminalId, term)

  const flushStdout = attachTerminalOutputStream(term, terminalId, child.stdout)
  const flushStderr = attachTerminalOutputStream(term, terminalId, child.stderr)
  child.stdin.on('error', () => {})

  // `exit` gives the process's exit status; it is NOT proof the output is
  // complete — see the grace comment above `terminalCloseGraceMs`. Keep the
  // two apart: `exit` only records the raw status, `close` (or the bounded
  // fallback below) is what actually finalizes the terminal record.
  let rawExitStatus = null
  let closeGraceTimer = null
  const finalizeTerminalExit = (status) => {
    if (closeGraceTimer) { clearTimeout(closeGraceTimer); closeGraceTimer = null }
    flushStdout()
    flushStderr()
    settleTerminalExit(term, status)
  }
  child.on('error', (cause) => {
    // A spawn failure never produced a real process or streams with output in
    // flight, so there is nothing to wait for — finalize immediately, same as
    // before this fix.
    appendTerminalOutput(term, `\n[terminal spawn error] ${cause.message}\n`)
    finalizeTerminalExit({ exitCode: null, signal: null })
  })
  child.on('exit', (code, signal) => {
    rawExitStatus = { exitCode: code, signal }
    closeGraceTimer = setTimeout(() => finalizeTerminalExit(rawExitStatus), terminalCloseGraceMs)
    closeGraceTimer.unref?.()
  })
  child.on('close', (code, signal) => {
    finalizeTerminalExit(rawExitStatus ?? { exitCode: code, signal })
  })

  ensureTerminalStdinBridge()
  return { terminalId }
}

function requireTerminal(terminalId) {
  const term = typeof terminalId === 'string' ? terminals.get(terminalId) : undefined
  if (!term || term.released) throw new Error(`unknown or released terminal ${boundedText(terminalId, '?', 64)}`)
  return term
}

function terminalOutputResult(term) {
  return {
    output: term.outputText,
    truncated: term.truncated,
    exitStatus: term.exitStatus ? { exitCode: term.exitStatus.exitCode, signal: term.exitStatus.signal } : null,
  }
}

function waitForTerminalExit(term) {
  if (term.exitStatus) return Promise.resolve({ exitCode: term.exitStatus.exitCode, signal: term.exitStatus.signal })
  return new Promise((resolve) => {
    term.waiters.push((status) => resolve({ exitCode: status.exitCode, signal: status.signal }))
  })
}

// `terminal/kill` per spec: terminate without releasing — the terminal stays
// valid for `output` and a later `wait_for_exit`. `terminal/release` per
// spec: terminate AND free resources — the id becomes invalid afterward. The
// two are different methods with different postconditions; collapsing them
// would silently break whichever one a real adapter relies on.
//
// Both route through `reapTerminalGroup` (below), which signals the
// terminal's WHOLE process group and escalates to SIGKILL if a bounded grace
// period passes with something still alive — not just the wrapper's own pid.
// `terminal/kill` used to send one SIGTERM to the wrapper and respond
// immediately: a command that traps or ignores SIGTERM (or is itself a
// launcher — a shell, npx, bunx, anything that forks — leaving a live
// descendant behind) then stayed alive while the caller had already been
// told the kill succeeded, and a caller that followed that ack with
// `terminal/wait_for_exit` could block the whole turn on it. This now waits
// for the escalation before treating the kill as done — the same ladder
// shape the teardown sweep below already used, just applied to the request
// itself instead of only at companion exit.
// `term.exitStatus` only says the WRAPPER exited, not that its process GROUP
// is empty — a launcher wrapper (shell, npx, bunx, anything that forks) can
// settle while a plain descendant it spawned is still alive and sharing its
// pgid. Guarding on `exitStatus` here used to skip the reap entirely for
// exactly that terminal: the request answered as if the kill had done
// something, while the still-live descendant was never even signalled once.
// Ask the question this function actually needs answered — is the GROUP
// gone — via the same `isGroupGone` probe `reapTerminalGroup` itself leads
// with, so this stays a fast, harmless no-op for the ordinary case (the
// wrapper exited AND nothing it forked outlived it) and only actually skips
// when there is truly nothing left to reap.
async function killTerminal(term) {
  if (isGroupGone(term.child?.pid)) return
  await reapTerminalGroup(term, 'SIGTERM', terminalKillGraceMs)
}

function releaseTerminal(term) {
  // Same question as killTerminal above: whether to bother signalling is
  // about the GROUP, not the wrapper's own `exitStatus`. A wrapper that
  // already exited can still have a live descendant sharing its pgid, and
  // that descendant has not yet been sent anything.
  if (!isGroupGone(term.child?.pid)) signalTerminalGroup(term, 'SIGTERM')
  term.released = true
  // A child that traps or ignores the SIGTERM release just sent is still
  // alive here — deleting it from `terminals` unconditionally used to make
  // it invisible to killAllLiveTerminals' teardown sweep from this point on,
  // so `terminal/release` defeated the very reap this file otherwise
  // guarantees. Keep a still-live terminal in the map; settleTerminalExit
  // deletes it once it actually exits. `requireTerminal` already refuses any
  // request naming a released id via `term.released`, and the stdin bridge
  // already skips released terminals, so the ACP postcondition (the id
  // becomes invalid immediately) is unchanged for every caller. Release
  // itself does not wait out the escalation ladder — the ACP method has no
  // "still terminating" reply to give — but killAllLiveTerminals' teardown
  // sweep runs that same ladder over every terminal still in this map
  // regardless of `released`, so a released-but-still-alive group is still
  // guaranteed gone before the companion exits.
  //
  // The guard below used to read `term.exitStatus`: true the instant the
  // WRAPPER settled, even with a live descendant sharing its pgid still
  // holding no pipe of its own — deleting right there hid that descendant
  // from the teardown sweep forever, since nothing else ever deletes this
  // entry for a wrapper that has already exited (settleTerminalExit only
  // runs once, and it already ran before this call). Ask about the GROUP
  // instead: if it is not yet gone, leave the entry in place so
  // killAllLiveTerminals still finds it; `reapTerminalGroup`'s own
  // `isGroupGone` check makes that sweep a cheap no-op the moment the group
  // actually is gone, so a terminal that exited normally with nothing left
  // behind is deleted here exactly as before.
  if (isGroupGone(term.child?.pid)) terminals.delete(term.terminalId)
}

// One check, no signal sent: true only when nothing in this pid's process
// group is left alive. Used as `reapTerminalGroup`'s fast path so a terminal
// whose whole group is already gone costs this function nothing beyond one
// `kill(-pid, 0)` probe.
function isGroupGone(groupId) {
  if (!groupId) return true
  try { process.kill(-groupId, 0); return false } catch {}
  return groupPids(groupId).length === 0
}

// Signal a terminal's WHOLE process group, not just the wrapper pid.
// createTerminal spawns with `detached: true`, so `term.child.pid` doubles as
// the group's own pgid — `process.kill(-pid, …)` reaches a shell/npx/bunx
// descendant the wrapper forked (a plain, non-detached spawn from the
// wrapper inherits that same pgid), the same trick `signalProcessGroup`
// already uses for the main agent child. Falls back to a direct signal on
// the wrapper only if the group call itself throws.
function signalTerminalGroup(term, signal) {
  const pid = term.child?.pid
  if (!pid) return
  try { process.kill(-pid, signal); return } catch {}
  try { term.child.kill(signal) } catch {}
}

// Bounded SIGTERM -> SIGKILL escalation for one terminal's whole process
// group, shared by the `terminal/kill` request path and the teardown sweep
// below — a single SIGTERM was not enough: measured directly, a child that
// traps or ignores it (`trap "" TERM`, or any adapter with its own signal
// handling) kept running past a plain signal, its open stdio pipes keeping
// Node's event loop alive, and this file exits through `process.exitCode`,
// never `process.exit()`, so the companion would hang indefinitely instead
// of leaving with the exit code it had already decided. `term.exitStatus`
// only says the WRAPPER exited — a descendant it forked before dying can
// still be alive and sharing its pgid — which is why this checks the GROUP
// rather than trusting that field, and why killAllLiveTerminals (below) no
// longer skips a terminal just because its wrapper already settled.
async function reapTerminalGroup(term, signal, graceMs) {
  const pid = term.child?.pid
  if (!pid || isGroupGone(pid)) return
  signalTerminalGroup(term, signal)
  if (await waitForGroupGone(pid, graceMs)) return
  signalTerminalGroup(term, 'SIGKILL')
  await waitForGroupGone(pid, graceMs)
}

// RULE: a terminal the companion spawned is the companion's to reap. Called
// from `main()`'s `finally`, which every JS-level exit path — normal
// completion, a thrown error, a finished cancellation — runs through.
// Best-effort only: a companion killed by an external SIGKILL runs no JS at
// all, the same blind spot every in-process cleanup in this file has.
//
// Sweeps EVERY terminal still in the map, not only ones whose wrapper is
// still running: `term.exitStatus` set only means the wrapper itself exited,
// and a launcher command (a shell, npx, bunx, anything that forks) can leave
// a live descendant behind sharing its process group after the wrapper is
// gone. Skipping here on `term.exitStatus` used to make exactly that
// descendant invisible to this sweep the moment its wrapper died.
// `reapTerminalGroup`'s own `isGroupGone` check makes this a no-op for a
// terminal whose whole group is already empty, so nothing here does extra
// signalling for the common case of a terminal that fully exited on its own.
async function killAllLiveTerminals(signal = 'SIGTERM') {
  const candidates = [...terminals.values()]
  if (!candidates.length) return
  await Promise.all(candidates.map((term) => reapTerminalGroup(term, signal, terminalKillGraceMs)))
}

async function handleTerminalRequest(message) {
  const { method, id, params } = message
  if (!terminalCapabilityEnabled) {
    // Defense in depth: even if this request should have been unreachable
    // (the capability was never advertised), refuse it explicitly rather
    // than falling through to the generic `respond(id, undefined)` an
    // unrecognised method gets — a silent empty ack here would look served.
    respondError(id, -32601, `${method} refused — terminal capability is not enabled on this lane`)
    return
  }
  try {
    switch (method) {
      case 'terminal/create':
        respond(id, createTerminal(params ?? {}))
        break
      case 'terminal/output':
        respond(id, terminalOutputResult(requireTerminal(params?.terminalId)))
        break
      case 'terminal/wait_for_exit':
        respond(id, await waitForTerminalExit(requireTerminal(params?.terminalId)))
        break
      case 'terminal/kill':
        await killTerminal(requireTerminal(params?.terminalId))
        respond(id, {})
        break
      case 'terminal/release':
        releaseTerminal(requireTerminal(params?.terminalId))
        respond(id, {})
        break
      default:
        respondError(id, -32601, `unknown method ${boundedText(method, '?', 64)}`)
    }
  } catch (cause) {
    respondError(id, -32602, boundedText(cause?.message, 'invalid terminal request', MAX_ERROR_TEXT))
  }
}

// A stdio Socket emits its OWN 'error'; `child.on('error')` is the ChildProcess
// and does not cover it, so an unhandled read fault here takes the whole process
// down. Found on the third pass: two doors were named, a survey of every stream
// with a 'data' listener and no 'error' listener found seven.
agent.stderr.on('error', () => {})
agent.stdout.on('error', () => {})
agent.stderr.on('data', (chunk) => {
  const text = String(chunk)
  stderrBuf = `${stderrBuf}${text}`.slice(-MAX_STDERR)
  process.stderr.write(`[agent-err] ${redact(text).slice(0, MAX_DISPLAY_TEXT)}`)
})
agent.stdin.on('error', () => {})
agent.on('error', (cause) => {
  agentError = cause
  noteError(cause)
  rejectPending(cause)
})
agent.on('exit', (code, signal) => {
  if (!agentClosed && cancellationActive) {
    rejectPending(new Error(`ACP child settled during cancellation: ${code ?? signal ?? 'unknown'}`))
  } else if (!agentClosed && !cancellationActive && !protocolCompleted && !agentError) {
    unexpectedExit = { code, signal }
    rejectPending(new Error(`ACP child exited before terminal observation: ${code ?? signal ?? 'unknown'}`))
  }
})


let mode = null
let modeChars = 0
// A worker can TYPE a terminal marker into its chat, and this function echoes
// chat verbatim. The companion itself is never fooled — `readTerminalOutbox`
// reads the FILE and a missing one exits 3 — but its log was, by anyone
// grepping it. GitHub #59: a worker emitted `TEAM_DONE <id>` in a message with
// zero tool calls and no outbox file, and a supervising loop grepping this
// stream reported success. The contract is the file; a stream that can be
// mistaken for the contract is a lie the contract cannot prevent.
//
// So the literal token is broken where it appears in text this process did not
// author. Not hidden — the reader still sees that a marker was typed and that
// it counted for nothing.
//
// What this defends, stated exactly: a HUMAN reading the log. NOTHING machine
// reads this stream for a verdict. The runner spawns this process with
// `stdio: ['ignore', logFd, logFd]`, so stdout is a file under
// `.tmux-teams/runner-logs/`, and it reads its verdict from the outbox FILE,
// hash-checked against the `outbox_digest` recorded at `delivered`
// (`loop-runner.mjs`). `[terminal]` is a diagnostic line, not an authority — an
// agent can type one into chat and this process will echo it, which is a
// misleading picture and not a false completion. An earlier version of this
// comment appointed `[terminal]` "the only line stating a verdict". That
// sentence was false when it was written, contradicted `kms.mjs` and
// `references/teammates-messaging.md` in the same tree, and was the only thing
// that made forging this stream worth anything: six review rounds were spent
// defending a witness we had appointed ourselves. Do not restore it, and do not
// add a machine reader. `tests/plugin-structure.test.mjs` refuses the two
// TEXTUAL SHAPES one needs — the token as a regex, or as a quoted string to
// search for — which is a tripwire across the shipped tree, not a proof of
// absence: `line.endsWith('] done')` would walk past it. What holds is this
// paragraph plus AC130; the test is what makes forgetting them expensive.
// Only a line that could be MISTAKEN for the contract is quoted — a marker plus
// this run's own task id, alone on its line. An agent explaining the rule, or
// reviewing this very file, writes `TEAM_DONE` constantly and none of that can
// be misread as a verdict; rewriting it corrupts documentation, code snippets
// and operator instructions. Caught by a release reviewer that had its OWN
// explanation of the outbox rule mangled while writing it, which is about as
// direct as evidence gets.
// What a TERMINAL would show, which is the only thing a marker can be mistaken
// for. Matching the raw bytes was not enough: `\x1b[2K` in front of a marker
// left the regex unmatched — the anchor allowed only spaces and tabs — while
// CSI 2K erases the line it is on, so the reader saw a clean standalone marker
// and an ANSI-stripping supervisor read one too. Reproduced against the real
// companion by a release reviewer.
//
// So the decision is made on the visible form and the WHOLE original line is
// replaced when it is a marker. A line that was wearing a costume does not get
// to keep it.
//
// The limits, stated rather than implied: CR is treated as a return to the
// start of the line, so only the segment after the last one is considered —
// which is what a terminal draws, though a partial overwrite could still leave
// characters from an earlier segment on screen. Cursor-positioning sequences
// that paint a marker from somewhere else on the screen are not modelled and
// cannot be, by anything short of a terminal emulator. This defends the line as
// far as a line can be defended, and what makes that enough is written above:
// no machine reads this stream for a verdict.
// The FULL CSI parameter grammar, `[0-9:;<=>?]`, not the `[0-9;?]` subset this
// started with. A colon-delimited SGR — `ESC[38:2::255:0:0m`, an ordinary
// truecolour sequence — fell through to the one-character fallback, which ate
// only `ESC[` and left `38:2::255:0:0m` sitting in front of the marker, so the
// matcher saw junk while a terminal and every real CSI stripper saw a clean
// coloured marker. Reproduced against the real companion by a reviewer.
// STRING sequences FIRST, and the order is the fix. `ESC ]` matched the
// single-character fallback further down, which ate the introducer and left the
// payload: `ESC ]0;title BEL TEAM_DONE <id>` became `0;titleTEAM_DONE <id>`,
// missed the anchor and went out raw — while a terminal swallowed the whole
// title sequence and drew a clean standalone marker. The round-5 CSI bypass
// again, in the one family of sequences nobody had counted. AC127 said "control
// sequences"; it covered CSI.
//
// OSC (`]`), DCS (`P`), SOS (`X`), PM (`^`) and APC (`_`) all carry a payload
// and all end at BEL or ST (`ESC \`) — named as the whole family so the next
// one is not a fresh discovery. An unterminated one runs to end of line, which
// is what a terminal does with it too.
const ANSI_OR_CONTROL = /\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b\[[0-9:;<=>?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|\u001b.|[\u0000-\u0008\u000b-\u001f\u007f]/g

// Characters that occupy no width — asked of UNICODE, not of a list we wrote.
//
// The list came first, from hunting the class the ANSI fix had just opened:
// nine probes, nine holes, all closed. A reviewer then produced a tenth,
// U+034F COMBINING GRAPHEME JOINER, which is `Mn` rather than `Cf` and was in
// no enumeration — the same shape as every other round of this, one more
// costume nobody had thought of.
//
// `Default_Ignorable_Code_Point` is the property that actually names this set:
// Unicode maintains it, it covers the joiners, the BOM, the bidi controls, the
// variation selectors and CGJ, and it grows without us. Enumerating a class
// that someone else already curates is how the tenth hole existed.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|[\u2028\u2029]|\p{Cf}/gu

// Width-occupying spaces that are not ASCII space or tab. A non-breaking space
// indenting a marker is indentation to every reader on earth and was not to the
// anchor.
const UNICODE_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu

// A carriage return at the END of a line is a LINE TERMINATOR — CRLF, which is
// entirely ordinary — and it is stripped before anything else. Treating it as
// an overwrite made `slice(lastIndexOf('\r') + 1)` return the empty string, so
// `TEAM_DONE <id>\r\n` matched nothing and went out raw. That was a regression
// introduced by the carriage-return handling itself, and TWO independent
// reviewers reproduced it in the same round. A CR in the MIDDLE is still an
// overwrite; only the terminator is not.
const visibleForm = (line) => line
  .replace(/\r+$/, '')
  .slice(line.replace(/\r+$/, '').lastIndexOf('\r') + 1)
  .replace(ANSI_OR_CONTROL, '')
  .replace(INVISIBLE, '')
  .replace(UNICODE_SPACE, ' ')

const quoteMarkers = (text, taskId) => {
  const forgeable = new RegExp(`^[ \\t]*TEAM_(DONE|BLOCKED|FAILED)[ \\t]+${escapeForRegExp(taskId)}[ \\t]*$`)
  return text.split('\n').map((line) => {
    const match = forgeable.exec(visibleForm(line))
    return match === null ? line : `TEAM~${match[1]} ${taskId} (typed in chat — only the outbox file counts)`
  }).join('\n')
}

const escapeForRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A partial trailing line, held back so it can be quoted as a LINE.
//
// `quoteMarkers` matches whole lines, and an ACP agent streams one message in
// as many chunks as it likes. Quoting each chunk on arrival meant a marker split
// across a chunk boundary — `...\nTEAM_DONE rev18c-` then `codex` — matched
// nothing in either half and reassembled on stdout as a raw, standalone marker
// line. The forgeable stream was back, through the ordinary streaming path
// rather than an exotic one. Found by a release reviewer; the test that shipped
// with the first fix sent a single chunk and could not have seen it.
let partialLine = ''
const flushPending = () => {
  if (partialLine === '') return
  // At flush time the partial line IS the whole line — nothing more is coming —
  // so it is quoted before it is written, never after.
  process.stdout.write(quoteMarkers(partialLine, taskId))
  partialLine = ''
}

function say(kind, value, messageId) {
  const spoken = redact(value)
  // Sliced FIRST, then quoted. The annotation is longer than the token it
  // replaces, so quoting first spends the agent's display budget on our own
  // words and cuts the tail of their message — where a worker's conclusion
  // usually sits. Raised by a release reviewer. A marker cut in half by the
  // slice is no longer a whole line and is not quoted, which is correct: a
  // truncated fragment cannot be mistaken for the contract either.
  const text = spoken.slice(0, MAX_DISPLAY_TEXT)
  // Every kind `say()` renders is text this process did not author — an agent
  // message, its thinking, or a user turn replayed on resume — and all three
  // reach the same human reader. Provenance is not an authority boundary here:
  // `user` was excluded with no reason recorded, so a replayed history carrying
  // a marker went through untouched. Raised by a release reviewer.
  const quotable = kind === 'say' || kind === 'think' || kind === 'user'
  const nextMode = `${kind}:${messageId ?? ''}`
  if (mode !== nextMode) {
    flushPending()
    if (mode !== null) process.stdout.write('\n')
    process.stdout.write(`[${kind}] `)
    mode = nextMode
    modeChars = 0
  }
  if (modeChars >= MAX_DISPLAY_TEXT) return
  const remaining = MAX_DISPLAY_TEXT - modeChars
  const piece = text.slice(0, remaining)
  // Counted against the AGENT's text, not against ours: the annotation is this
  // process talking and must not shrink what the worker is allowed to say.
  modeChars += piece.length
  if (!quotable) {
    process.stdout.write(piece)
    return
  }
  partialLine += piece
  const lastBreak = partialLine.lastIndexOf('\n')
  if (lastBreak === -1) return
  process.stdout.write(quoteMarkers(partialLine.slice(0, lastBreak + 1), taskId))
  partialLine = partialLine.slice(lastBreak + 1)
}

function line(value) {
  flushPending()
  if (mode !== null) process.stdout.write('\n')
  mode = null
  modeChars = 0
  console.log(redact(String(value)).slice(0, MAX_DISPLAY_TEXT))
}

// #62. The same rule as chat, applied to the unit that actually bounds these
// strings. A tool title, a plan entry and a permission title are chosen by the
// AGENT and reach the log through `line()`, which composes them into
// `[tool] …` — so a marker inside one is never alone on a line, and an
// anchored reader cannot be fooled by it. Measured before it was touched,
// because the issue said otherwise: `boundedText` already flattens control
// characters, so even a title carrying newlines came out as
// `[plan] ✓ a TEAM_DONE probe-task b`.
//
// What survives is a PERSON skimming the log and reading a completion marker in
// a plan tick. So the same distinction chat draws, on the field instead of the
// line: a field whose whole visible content is a marker is a costume and gets
// quoted; a field that merely mentions one is documentation and is left alone.
// Bounded FIRST, then judged — bounding is what collapses a multi-line title to
// one line, and quoting before it would rewrite a marker that was never going
// to stand alone.
const quoteAgentField = (value, fallback = '') => {
  const text = boundedText(value, fallback)
  const forgeable = new RegExp(`^[ \\t]*TEAM_(DONE|BLOCKED|FAILED)[ \\t]+${escapeForRegExp(taskId)}[ \\t]*$`)
  const match = forgeable.exec(visibleForm(text))
  return match === null ? text : `TEAM~${match[1]} ${taskId} (a label, not a verdict — only the outbox file counts)`
}

const planMark = { completed: '✓', in_progress: '▶', pending: '◯' }
function render(update) {
  switch (update?.sessionUpdate) {
    case 'user_message_chunk':
      if (update.content?.type === 'text') say('user', update.content.text, update.messageId)
      break
    case 'agent_message_chunk':
      if (update.content?.type === 'text') say('say', update.content.text, update.messageId)
      break
    case 'agent_thought_chunk':
      if (update.content?.type === 'text') say('think', update.content.text, update.messageId)
      break
    case 'tool_call':
      line(`[tool] ${update.kind ? `${boundedText(update.kind)} · ` : ''}${quoteAgentField(update.title ?? update.toolCallId)}${update.status ? ` (${boundedText(update.status)})` : ''}`)
      break
    case 'tool_call_update':
      if (update.status) line(`[tool] ${quoteAgentField(update.title ?? update.toolCallId)} → ${boundedText(update.status)}`)
      break
    case 'plan':
      line(`[plan] ${(update.entries ?? []).slice(0, MAX_PLAN_ENTRIES).map((entry) => `${planMark[entry.status] ?? '◯'} ${quoteAgentField(entry.content)}`).join('  ')}`)
      break
    default:
      break
  }
}

const rl = createInterface({ input: agent.stdout })
// Node forwards the input stream's error onto the Interface, so the listener on
// `agent.stdout` does not cover this one. Routed to `failProtocol` rather than
// swallowed: a lane whose adapter stream failed has not produced an answer, and
// a silently-continuing companion would settle as though it had.
rl.on('error', (err) => failProtocol(err))
rl.on('line', (rawLine) => {
  if (!rawLine.trim()) return
  let message
  try { message = JSON.parse(rawLine) } catch { return }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
  const hasResult = Object.prototype.hasOwnProperty.call(message, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(message, 'error')
  if (message?.jsonrpc !== '2.0' || (!message.method && !(hasId && (hasResult || hasError)))) return
  noteProtocolActivity()

  if (hasId && (hasResult || hasError) && pending.has(message.id)) {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (entry.trace) {
      entry.trace.correlated = true
      entry.trace.response_error = Boolean(message.error)
      entry.trace.response_digest = sha256Text(stableJson(message))
      entry.trace.acknowledged_at = iso(Date.now())
    }
    recordTestStage(`response-${entry.method.replaceAll('/', '-')}-correlated`)
    if (!message.error && ['initialize', 'session/new', 'session/load', 'session/set_config_option'].includes(entry.method)) {
      meaningfulProgress(`${entry.method.replace('/', '_')}_response`, { label: `${entry.method} response` })
    }
    if (entry.method === 'session/prompt' && !message.error) meaningfulProgress('prompt_response', { label: 'turn response' })
    // The ack ACP actually promises. `session/cancel` is a NOTIFICATION in the
    // spec's own wire example — an agent owes no response to it, and until
    // 2026-08-13 this file waited `cancelGraceMs` on exactly that unpromised
    // reply while the documented confirmation went past unused. ACP v1: "the
    // Agent MUST respond to the original `session/prompt` request with the
    // `cancelled` stop reason ... so that Clients can reliably confirm the
    // cancellation." Additive on purpose: whichever arrives first settles, so a
    // spec-conforming agent stops costing us a timeout and one that answers
    // neither still meets the SIGTERM/SIGKILL ladder unchanged.
    if (entry.method === 'session/prompt' && !message.error && cancellationActive &&
        !cancellationResponseSettled && message.result?.stopReason === 'cancelled') {
      cancellationResponseSettled = true
      cancellationAck = true
      if (cancelAckTimer) clearTimeout(cancelAckTimer)
      recordTestStage('cancel-ack')
      console.error('[cancel] turn resolved with stopReason=cancelled; treating as the acknowledgement')
      appendControlEvent('cancel confirmed by prompt stopReason')
      try { agent.stdin.end() } catch {}
      startCancellationGrace('prompt-cancelled')
    }
    if (entry.method === 'session/cancel') {
      cancellationResponseSettled = true
      if (cancelAckTimer) clearTimeout(cancelAckTimer)
      if (!message.error) {
        cancellationAck = true
        recordTestStage('cancel-ack')
        console.error('[cancel] ACK received; closing stdin and waiting for child settlement')
      } else {
        console.error('[cancel] ACP cancellation returned an error; observing child state')
      }
      try { agent.stdin.end() } catch {}
      startCancellationGrace(message.error ? 'error' : 'ack')
    }
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
    return
  }
  // TYPE, not truthiness. `.startsWith` below threw TypeError on a frame like
  // `{"id":1,"method":42}`, and an uncaught throw inside the readline callback
  // takes the companion down before its terminal snapshot — one bad frame from
  // an adapter and the lane stops with no record of why. Found by the PR review
  // bot on this release's own bytes.
  if (hasId && typeof message.method === 'string' && message.method) {
    if (message.method === 'session/request_permission') {
      // ACP v1 prompt-turn, Cancellation: "The Client MUST respond to all
      // pending `session/request_permission` requests with the `cancelled`
      // outcome." This branch did not exist until 2026-08-13, so a permission
      // request arriving after cancellation had begun was still auto-approved —
      // the runner told an agent it was being torn down and then handed it
      // another tool call. A MUST, and the one place in this file where
      // answering the question at all is the wrong answer.
      if (cancellationActive) {
        line(`[permission] ${quoteAgentField(message.params?.toolCall?.title, '?')} -> cancelled (turn is cancelling)`)
        respond(message.id, { outcome: { outcome: 'cancelled' } })
        return
      }
      const options = Array.isArray(message.params?.options) ? message.params.options : []
      const pick = options.find((option) => option.kind === 'allow_always')
        ?? options.find((option) => option.kind === 'allow_once')
        ?? options[0]
      if (pick) {
        line(`[permission] ${quoteAgentField(message.params?.toolCall?.title, '?')} -> ${boundedText(pick.name ?? pick.optionId)}`)
        respond(message.id, { outcome: { outcome: 'selected', optionId: pick.optionId } })
      } else {
        line(`[permission] ${quoteAgentField(message.params?.toolCall?.title, '?')} -> cancelled (no options)`)
        respond(message.id, { outcome: { outcome: 'cancelled' } })
      }
    } else if (message.method.startsWith('terminal/')) {
      void handleTerminalRequest(message)
    } else {
      respond(message.id, undefined)
    }
    return
  }
  if (message.method === 'session/update' && sessionMatches(message)) {
    handleUpdate(message.params?.update)
    render(message.params?.update)
  }
})

function setTerminalState(next, reason, { terminal = false } = {}) {
  setTerminationReason(reason)
  livenessState = next
  if (terminal) terminalSnapshotFinalized = true
  if (livenessTimer) clearInterval(livenessTimer)
  if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer)
  if (cancelGraceTimer) clearTimeout(cancelGraceTimer)
  if (cancelAckTimer) clearTimeout(cancelAckTimer)
  if (processKillTimer) clearTimeout(processKillTimer)
  if (!terminal) schedulePersistence(true)
}

function livenessTick() {
  if (isLivenessTerminal() || cancellationActive) return
  const now = Date.now()
  // A tool vouches for the run only while it is itself fresh. `in_progress` used
  // to renew the lease unconditionally, so ONE tool call that never reported
  // again — a request that hung, a command waiting on input that will not come —
  // kept a dead run alive for ever. That is the same trick the message path
  // refuses next door: `updateTextProgress` fingerprints its text precisely so an
  // agent repeating itself cannot renew, and then this branch handed the identical
  // exemption to anything that had opened a tool.
  //
  // Freshness is measured with `stallMs`, the operator's own number, so no new
  // knob appears: a tool silent for longer than they said they would wait stops
  // counting, and the ordinary two-miss stall path decides from there — the same
  // ceiling everything else in this file answers to.
  //
  // An `updated_at` that cannot be parsed RENEWS. Failing to prove a tool is
  // stale is not proof that it is dead, and the direction of that unknown is the
  // difference between letting a slow run finish and killing a working one.
  if (activeToolIds.size > 0) {
    const allStale = [...activeToolIds.values()].every((tool) => {
      const updatedMs = Date.parse(tool?.updated_at ?? '')
      return Number.isFinite(updatedMs) && now - updatedMs >= stallMs
    })
    if (!allStale) {
      nextLeaseExpiryMs = now + stallMs
      if (promptStarted && livenessState !== 'tool_running') setLivenessState('tool_running')
      schedulePersistence()
      return
    }
  }
  if (livenessState === 'stalled') return
  if (now < nextLeaseExpiryMs) return
  if (livenessState !== 'suspected_stalled') {
    consecutiveMisses = 1
    nextLeaseExpiryMs = now + stallMs
    addStallHistory({
      state: 'suspected_stalled',
      evidence: 'progress_lease_expired',
      last_protocol_activity_at: iso(lastProtocolActivityMs),
      last_meaningful_progress_at: iso(lastMeaningfulProgressMs),
      active_tools: activeToolEvidence(),
    })
    recordTestStage('suspected-stalled')
    setLivenessState('suspected_stalled')
    return
  }
  consecutiveMisses = 2
  confirmStall()
}

function startCancellationGrace(observation = 'response') {
  if (cancellationGraceStarted || cancellationFinalized || agentClosed || agentExitResult) return
  cancellationGraceStarted = true
  console.error(`[cancel] grace ${cancelGraceMs}ms after ${boundedText(observation, 'response', MAX_TEXT)}`)
  appendControlEvent(`grace ${cancelGraceMs}ms after ${boundedText(observation, 'response', MAX_TEXT)}`)
  recordTestStage('cancel-grace')
  cancelGraceTimer = setTimeout(() => sendTerminationSignal('SIGTERM'), cancelGraceMs)
}

function sendTerminationSignal(signal) {
  if (signal === 'SIGKILL') {
    if (killAttempted) return false
    killAttempted = true
  } else {
    if (terminationAttempted) return false
    terminationAttempted = true
  }
  appendControlEvent(`signal ${signal} (cancel)`)
  console.error(`[cancel] signal ${signal}`)
  const childSettledBeforeSignal = Boolean(agentClosed || agentExitResult)
  const signalResult = signalProcessGroup(signal, 'cancel')
  if (signalResult.delivered) recordTestStage('process-signal')
  if (signalResult.childDelivered && !childSettledBeforeSignal) {
    childSettlementSignalDelivered = true
    if (signal === 'SIGKILL') killDelivered = true
    else terminationDelivered = true
  } else if (signalResult.delivered) {
    descendantCleanupSignalDelivered = true
  }
  if (signal === 'SIGTERM' && !agentClosed && !agentExitResult) {
    processKillTimer = setTimeout(() => sendTerminationSignal('SIGKILL'), processKillGraceMs)
  }
  return signalResult.delivered
}

function beginCancellation(reason, targetState, { timedOut = false } = {}) {
  if (cancellationActive || terminalRecorded || terminalSnapshotFinalized) return
  cancellationActive = true
  cancellationReason = boundedText(reason, 'unknown', MAX_TERMINATION_REASON)
  cancellationTargetState = targetState
  cancellationTimedOut = timedOut
  setTerminationReason(reason)
  setLivenessState('cancelling')
  // ACP v1 prompt-turn: "The Client SHOULD preemptively mark all non-finished
  // tool calls pertaining to the current turn as `cancelled` as soon as it
  // sends the `session/cancel` notification."
  //
  // We cannot write that word. ACP v1 defines exactly four tool-call statuses —
  // pending, in_progress, completed, failed — and `cancelled` is not among
  // them, so the spec asks for a value its own schema has no room for.
  // `VALID_TOOL_STATUSES` matches those four exactly and `pulse-v4.schema.json`
  // pins the same enum, so inventing a fifth here would be a contract
  // amendment made to satisfy a word rather than a reader.
  //
  // What the SHOULD is actually preventing is achievable and is done here: a
  // cancelled turn's unfinished tool calls stop being reported as RUNNING.
  // Without this the liveness snapshot keeps them in `active_tools` and the
  // state keeps reading `tool_running` for work that was torn down. Records in
  // `toolsById` are left untouched, and updates arriving after this point are
  // still accepted — also a SHOULD, in the same paragraph.
  if (activeToolIds.size > 0) {
    const dropped = activeToolIds.size
    activeToolIds.clear()
    console.error(`[cancel] ${dropped} unfinished tool call(s) no longer reported as running`)
    appendControlEvent(`cancel cleared ${dropped} active tool call(s)`)
  }
  flushPersistence()
  if (activeSessionId) {
    cancellationAttempted = true
    const displaySessionId = persistedSessionId(activeSessionId) || '<unknown-session>'
    console.error(`[cancel] session/cancel ${displaySessionId}`)
    appendControlEvent(`session/cancel ${displaySessionId}`)
    request('session/cancel', { sessionId: activeSessionId }, { allowAfterInterruption: true })
      .catch(() => {
        cancellationResponseSettled = true
        if (cancelAckTimer) clearTimeout(cancelAckTimer)
        try { agent.stdin.end() } catch {}
        startCancellationGrace('error')
      })
    cancelAckTimer = setTimeout(() => {
      if (cancellationResponseSettled || cancellationGraceStarted || agentClosed || agentExitResult) return
      cancellationResponseSettled = true
      console.error('[cancel] ACP cancellation acknowledgement timeout; proceeding with bounded grace')
      startCancellationGrace('ack-timeout')
    }, cancelGraceMs)
  } else {
    cancellationUnavailable = true
    addStallHistory({
      state: 'cancellation_unavailable',
      reason,
      evidence: 'no_session_id',
    })
    console.error('[cancel] session/cancel unavailable before ACP session existed')
    appendControlEvent('session/cancel unavailable')
    recordTestStage('cancel-unavailable')
    flushPersistence()
    sendTerminationSignal('SIGTERM')
  }
}

function confirmStall() {
  addStallHistory({
    state: 'stalled',
    evidence: 'two_consecutive_expired_progress_leases',
    last_protocol_activity_at: iso(lastProtocolActivityMs),
    last_meaningful_progress_at: iso(lastMeaningfulProgressMs),
    active_tools: activeToolEvidence(),
  })
  setTerminationReason('stall_confirmed')
  if (stallPolicy === 'report') {
    console.error('[liveness] confirmed stall (report-only policy)')
    setLivenessState('stalled')
    schedulePersistence(true)
    recordTestStage('stalled')
    return
  }
  beginCancellation('stall_confirmed', 'stalled')
}

function hardTimeout() {
  if (isLivenessTerminal() || cancellationActive) return
  console.error(`\n[hard-timeout ${hardTimeoutSec}s] — explicit hard ceiling reached`)
  beginCancellation('hard_timeout', 'failed', { timedOut: true })
}

function markPromptStarted() {
  promptStarted = true
  const now = Date.now()
  leaseAnchorMs = now
  nextLeaseExpiryMs = now + stallMs
  setLivenessState(activeToolIds.size > 0 ? 'tool_running' : 'active')
  schedulePersistence(true)
}

function extractResumeId() {
  let resumeId = process.env.ACP_RESUME?.trim() ?? ''
  if (resumeId) {
    if (!SESSION_ID_RE.test(resumeId)) {
      console.error('[warn] ACP_RESUME session id is unsafe or oversized; starting fresh')
      return ''
    }
    return resumeId
  }
  if (!existsSync(sessionFile)) return ''
  try {
    const stat = statSync(sessionFile)
    if (!stat.isFile()) throw new Error('persisted session entry is not a file')
    const stored = readFileSync(sessionFile, 'utf8').trim()
    if (!SESSION_ID_RE.test(stored)) throw new Error('persisted session id is unsafe or oversized')
    return stored
  } catch (cause) {
    console.error(`[warn] could not read persisted session id: ${cause.message}; starting fresh`)
    return ''
  }
}

function assertSessionId(value, source) {
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) {
    if (!receiptRequired && typeof value === 'string' && value.trim()) {
      return `session-${sha256Text(value).slice('sha256:'.length, 'sha256:'.length + 24)}`
    }
    throw Object.assign(new Error(`${source} returned an unsafe or oversized ACP session id`), { code: 'invalid_session_id' })
  }
  return value
}

async function persistFailureReceiptIfNeeded(cause = null) {
  if (receiptRecord) return
  const requestedOperation = operationContext.requestedOperation === 'load' ? 'load' : 'new'
  const fields = {
    requestedOperation,
    performedOperation: null,
    operationOutcome: controllerInterrupted ? 'interrupted' : 'failed',
    requestedResumeSessionId: requestedOperation === 'load' ? operationContext.requestedResumeSessionId : null,
    effectiveSessionId: null,
    priorReceipt,
    ...requestedPriorLineage(),
    operationWitness: 'none',
    operationTrace: operationContext.operationTrace,
    resumeStatus: requestedOperation === 'load' ? 'load_failed' : 'not_requested',
  }
  try {
    await tryPersistOperationReceipt(fields)
  } catch (cause) {
    noteError(cause)
    console.error(`[receipt] failure receipt unavailable: ${boundedText(cause.message, 'receipt failure', MAX_ERROR_TEXT)}`)
  }
}

async function persistInterruptedReceiptIfNeeded() {
  await persistFailureReceiptIfNeeded(Object.assign(new Error('controller interrupted'), { code: 'controller_interrupted' }))
}

function clearStaleOutbox() {
  const outboxPath = join(cwd, '.mailbox-out', taskId)
  if (!existsSync(outboxPath)) return
  // lstat, not stat: a symlink left here would otherwise be followed, and the
  // check would report on the target instead of the link that is being removed.
  if (!lstatSync(outboxPath).isFile()) {
    throw Object.assign(new Error(`${outboxPath} is not a regular file — expected a single flat file`), { code: 'invalid_outbox' })
  }
  unlinkSync(outboxPath)
}

// The outbox is written by the worker and read by this process, and the worker
// chooses what kind of file lands at that path. Rejecting only a directory left
// two openings: a symlink pointed the terminal verdict at bytes outside the
// repo, and a FIFO hung the synchronous read for ever — with the event loop
// blocked, not even the hard-timeout timer could fire. O_NOFOLLOW refuses the
// link at open() rather than after an lstat that a rename could invalidate, and
// O_NONBLOCK makes opening a FIFO return instead of waiting for a writer, so
// fstat can reject it. The digest is returned because a verdict this process
// verified is not the same fact as the bytes the runner harvests later.
function readTerminalOutbox() {
  const outboxPath = join(cwd, '.mailbox-out', taskId)
  let fd
  try {
    fd = openSync(outboxPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
  } catch (cause) {
    if (cause.code === 'ENOENT') throw Object.assign(new Error(`worker finished the turn but wrote no ${outboxPath}`), { code: 'no_outbox' })
    if (cause.code === 'ELOOP' || cause.code === 'EMLINK') {
      throw Object.assign(new Error(`${outboxPath} is a symlink — expected a single flat file`), { code: 'invalid_outbox' })
    }
    throw Object.assign(new Error(`${outboxPath} could not be opened: ${cause.code ?? cause.message}`), { code: 'invalid_outbox' })
  }
  let bytes
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw Object.assign(new Error(`${outboxPath} is not a regular file — expected a single flat file`), { code: 'invalid_outbox' })
    }
    if (stat.size > MAX_OUTBOX_BYTES) {
      throw Object.assign(new Error(`${outboxPath} exceeds its bounded size of ${MAX_OUTBOX_BYTES} bytes`), { code: 'invalid_outbox' })
    }
    bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < stat.size) {
      const read = readSync(fd, bytes, offset, stat.size - offset, offset)
      if (read <= 0) break
      offset += read
    }
    if (offset !== stat.size) {
      throw Object.assign(new Error(`${outboxPath} changed size while it was being read`), { code: 'invalid_outbox' })
    }
  } finally {
    closeSync(fd)
  }
  const text = bytes.toString('utf8')
  const digest = sha256Bytes(bytes)
  const lines = text.split('\n').map((value) => value.trim()).filter(Boolean)
  const last = lines.at(-1) ?? ''
  const terminal = last === `TEAM_DONE ${taskId}` ? 'done'
    : last === `TEAM_BLOCKED ${taskId}` ? 'blocked'
      : last === `TEAM_FAILED ${taskId}` ? 'failed' : 'invalid'
  // GitHub #53: `invalid` said only what the last line WAS, never what the rule
  // is, and could not tell a misplaced marker from a missing one. A worker that
  // wrote `TEAM_DONE <id>` at line 61 and an EVIDENCE block after it got back
  // the quoted tail of its evidence — so it could not learn the rule, and the
  // same delivery was retried twice before a human diagnosed it by reading the
  // file. The contract states the rule in the brief; only the failure message
  // did not.
  const misplaced = terminal !== 'invalid' ? null
    : lines.findIndex((value) => value === `TEAM_DONE ${taskId}`
      || value === `TEAM_BLOCKED ${taskId}` || value === `TEAM_FAILED ${taskId}`)
  const wrongId = terminal !== 'invalid' && misplaced !== -1 ? null
    : lines.findIndex((value) => /^TEAM_(DONE|BLOCKED|FAILED)\b/.test(value))
  const diagnosis = terminal !== 'invalid' ? null
    : misplaced !== null && misplaced !== -1
      ? `the marker is on line ${misplaced + 1} of ${lines.length}, and it must be the LAST non-empty line`
        + ' — EVIDENCE and every other section belongs BEFORE it'
      : wrongId !== null && wrongId !== -1
        ? `line ${wrongId + 1} carries a marker for a different task (${lines[wrongId]}); this run is ${taskId}`
        : `no TEAM_DONE/TEAM_BLOCKED/TEAM_FAILED ${taskId} line anywhere in the file`
  return { outboxPath, text, terminal, digest, diagnosis }
}

function classifyCancellationOutcome(record) {
  const childCode = Number.isInteger(record.child_exit_code) ? record.child_exit_code : null
  const childSignal = record.child_signal ?? null
  // Descendant-only cleanup is not a forced child settlement. It is retained
  // as provenance, but cannot turn a clean child exit into stalled/forced.
  const childSettlementSignalDelivered = Boolean(record.child_settlement_signal_delivered)

  if (record.timed_out) {
    return { terminal: 'hard-timeout', state: 'failed', reason: 'hard_timeout', forced: childSettlementSignalDelivered }
  }
  if (childCode !== null && childCode !== 0) {
    return { terminal: 'agent-exit', state: 'failed', reason: 'agent_exit', forced: false }
  }
  if (childSignal && !childSettlementSignalDelivered) {
    return { terminal: 'agent-exit', state: 'failed', reason: 'agent_exit', forced: false }
  }
  if (childSettlementSignalDelivered) {
    return { terminal: 'stalled', state: 'stalled', reason: record.cancellation_reason, forced: true }
  }
  if (record.cancel_ack || childCode === 0) {
    return { terminal: 'cancelled', state: 'cancelled', reason: record.cancellation_reason, forced: false }
  }
  return { terminal: 'stalled', state: 'stalled', reason: record.cancellation_reason, forced: false }
}

function terminalEvidence(terminal, exitCode, settlement, extras = {}) {
  return {
    terminal,
    exit_code: exitCode,
    receipt_digest: receiptDigest,
    receipt_persistence_failed: terminationReason === 'receipt_persistence_failed',
    liveness_state: livenessState,
    termination_reason: boundedText(terminationReason, 'unknown', MAX_TERMINATION_REASON),
    cancellation_unavailable: settlement?.cancellation_unavailable ?? cancellationUnavailable,
    ...settlementFacts(settlement),
    ...extras,
  }
}

function assertPersistedTerminalSnapshot(expectedState, expectedReason) {
  const raw = readFileSync(livenessPath, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('terminal liveness snapshot exceeds production cap')
  const value = JSON.parse(raw)
  if (value.schema_version !== 'acp-liveness.v1') throw new Error('terminal liveness snapshot has the wrong schema')
  if (value.task_id !== taskId) throw new Error('terminal liveness snapshot task id disagrees')
  if (value.dispatch_id !== boundedText(dispatchId, 'unknown', MAX_DISPATCH_ID)) throw new Error('terminal liveness snapshot dispatch id disagrees')
  if (value.liveness_state !== expectedState) throw new Error('terminal liveness snapshot state disagrees')
  if (value.termination_reason !== expectedReason) throw new Error('terminal liveness snapshot termination reason disagrees')
  if (!Array.isArray(value.active_tools) || value.active_tools.length !== 0) throw new Error('terminal liveness snapshot retains active tools')
  return value
}

function persistTerminalSnapshot(expectedState, expectedReason) {
  writeLivenessSnapshot({ required: true })
  consumeTerminalPersistenceFailure('readback')
  assertPersistedTerminalSnapshot(expectedState, expectedReason)
  const dispatch = writeDispatchRecord({ required: true })
  if (!dispatch || !new RegExp(`^task_id: ${taskId}$`, 'm').test(dispatch)) throw new Error('terminal dispatch task id disagrees')
  if (!new RegExp(`^liveness_state: ${expectedState}$`, 'm').test(dispatch)) throw new Error('terminal dispatch state disagrees')
  if (!new RegExp(`^termination_reason: ${expectedReason}$`, 'm').test(dispatch)) throw new Error('terminal dispatch reason disagrees')
  if (!/^active_tools: \[\]$/m.test(dispatch)) throw new Error('terminal dispatch retains active tools')
}

async function failClosedTerminalPersistence({ settlement, originalExitCode, timedOut = false, evidencePresent = false } = {}, cause) {
  noteError(cause)
  const failureReason = 'liveness_persistence_failed'
  setTerminalState('failed', failureReason, { terminal: true })
  try {
    persistTerminalSnapshot('failed', failureReason)
  } catch (fallbackCause) {
    noteError(fallbackCause)
    console.error(`[fatal] ${boundedText(fallbackCause.message, failureReason, MAX_ERROR_TEXT)}`)
  }
  const nonzeroExitCode = Number.isInteger(originalExitCode) && originalExitCode !== 0 ? originalExitCode : 1
  const evidence = terminalEvidence('liveness-persistence-failed', nonzeroExitCode, settlement, {
    evidence_present: evidencePresent,
    timed_out: timedOut,
    liveness_persistence_failed: true,
    persistence_error: boundedText(cause?.message ?? cause, failureReason, MAX_ERROR_TEXT),
  })
  terminalRecorded = true
  recordGovernedTerminalSafely('failure', evidence)
  recordTerminal('liveness-persistence-failed', {
    timedOut,
    evidencePresent,
    exitCode: nonzeroExitCode,
    settlement,
    livenessPersistenceFailed: true,
  })
  return nonzeroExitCode
}

async function finishTerminal(terminal, exitCode, {
  timedOut = false,
  evidencePresent = false,
  reason,
  settlement = null,
  outboxDigest = null,
} = {}) {
  if (terminalRecorded) return exitCode
  const capturedSettlement = captureSettlementRecord(settlement ?? {}, { timedOut })
  const state = terminal === 'done' ? 'completed' : terminal === 'blocked' || terminal === 'failed' ? 'failed' : 'failed'
  const terminalReason = boundedText(reason ?? (terminal === 'done' ? 'none' : `mailbox_${terminal}`), 'unknown', MAX_TERMINATION_REASON)
  setTerminalState(state, terminalReason, { terminal: true })
  try {
    persistTerminalSnapshot(state, terminalReason)
  } catch (cause) {
    return failClosedTerminalPersistence({ settlement: capturedSettlement, originalExitCode: exitCode, timedOut, evidencePresent }, cause)
  }
  terminalRecorded = true
  recordGovernedTerminalSafely(terminal === 'done' ? 'success' : 'failure', terminalEvidence(terminal, exitCode, capturedSettlement, {
    evidence_present: evidencePresent,
    outbox_digest: outboxDigest,
  }))
  recordTerminal(terminal, { timedOut, evidencePresent, exitCode, settlement: capturedSettlement, outboxDigest })
  return exitCode
}

async function finishCancellation() {
  if (cancellationFinalized) return 1
  cancellationFinalized = true
  const reaped = await closeAndReapChild()
  if (cancelGraceTimer) clearTimeout(cancelGraceTimer)
  if (processKillTimer) clearTimeout(processKillTimer)
  const settlement = captureSettlementRecord(reaped, {
    timedOut: cancellationTimedOut,
    reason: cancellationReason,
  })
  if (process.env.ACP_TEST_MUTATE_SETTLEMENT_AFTER_CAPTURE === '1') {
    // Regression hook: these mutable trackers must not be consulted after
    // the immutable decision-boundary record has been captured.
    cancellationAck = true
    terminationDelivered = true
    killDelivered = true
    childSettlementSignalDelivered = true
    descendantCleanupSignalDelivered = true
    forcedReapDelivered = true
  }
  const classification = classifyCancellationOutcome(settlement)
  const terminalExitCode = classification.terminal === 'agent-exit' && Number.isInteger(settlement.child_exit_code)
    ? settlement.child_exit_code
    : 1
  setTerminalState(classification.state, classification.reason, { terminal: true })
  try {
    persistTerminalSnapshot(classification.state, classification.reason)
  } catch (cause) {
    return failClosedTerminalPersistence({
      settlement,
      originalExitCode: terminalExitCode,
      timedOut: settlement.timed_out,
    }, cause)
  }
  terminalRecorded = true
  recordGovernedTerminalSafely('failure', terminalEvidence(classification.terminal, terminalExitCode, settlement, {
    timed_out: settlement.timed_out,
  }))
  recordTerminal(classification.terminal, {
    timedOut: settlement.timed_out,
    exitCode: terminalExitCode,
    settlement,
  })
  return 1
}

async function finishDirectFailure(terminal, reason, exitCode = 1, {
  recordExitCode = exitCode,
  settlement: existingSettlement = null,
} = {}) {
  if (cancellationActive) return finishCancellation()
  const reaped = existingSettlement ?? await closeAndReapChild()
  const settlement = captureSettlementRecord(reaped)
  const terminalReason = boundedText(reason, 'unknown', MAX_TERMINATION_REASON)
  setTerminalState('failed', terminalReason, { terminal: true })
  try {
    persistTerminalSnapshot('failed', terminalReason)
  } catch (cause) {
    return failClosedTerminalPersistence({ settlement, originalExitCode: exitCode }, cause)
  }
  terminalRecorded = true
  recordGovernedTerminalSafely('failure', terminalEvidence(terminal, recordExitCode, settlement))
  recordTerminal(terminal, { exitCode: recordExitCode, settlement })
  return exitCode
}

async function protocolRun() {
  const resumeId = receiptRequired ? explicitResumeId : extractResumeId()
  const requestedOperation = receiptRequired ? requestedOperationEnv : (resumeId ? 'load' : 'new')
  operationContext = {
    requestedOperation,
    requestedResumeSessionId: requestedOperation === 'load' ? resumeId : null,
    operationTrace: null,
    initializeTrace: null,
  }
  setLivenessState('awaiting_agent')
  flushPersistence()
  assertProtocolFence('initialize')
  const initializeTrace = {}
  operationContext.initializeTrace = initializeTrace
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: adapterProfile?.agent_info,
    // `terminal` is the ACP boolean capability (ClientCapabilities.terminal in
    // the v1 schema, not an object like `fs`) that gates every `terminal/*`
    // method. Advertising it when nobody asked for login mode would be
    // offering the adapter a login route on an ordinary lane; the key is
    // omitted entirely rather than sent as `false`, so a reader of the wire
    // traffic sees an ABSENT capability, not a declined one, on every path
    // that did not ask for it.
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      ...(terminalCapabilityEnabled ? { terminal: true } : {}),
    },
  }, { trace: initializeTrace })
  assertProtocolFence('initialize response')
  enforceObservedInitializeIdentity(init)
  const canLoad = init?.agentCapabilities?.loadSession === true
  let sessionId
  let sessionResponse
  let operationTrace = null
  const persistFailedOperation = async (trace, fallbackOperation = null) => {
    operationContext.operationTrace = trace
    try {
      await tryPersistOperationReceipt({
        requestedOperation,
        performedOperation: null,
        operationOutcome: controllerInterrupted ? 'interrupted' : 'failed',
        requestedResumeSessionId: requestedOperation === 'load' ? resumeId : null,
        effectiveSessionId: null,
        priorReceipt,
        operationWitness: 'none',
        operationTrace: trace,
        resumeStatus: requestedOperation === 'load' ? 'load_failed' : 'not_requested',
      })
    } catch (receiptCause) {
      throw receiptCause
    }
    if (fallbackOperation) console.error(`[receipt] ${fallbackOperation} failed before prompt`)
  }
  const startNewSession = async (fallback = false) => {
    activeSessionId = null
    setLivenessState('awaiting_agent')
    operationTrace = {}
    operationContext.operationTrace = operationTrace
    try {
      sessionResponse = await request('session/new', { cwd, mcpServers: [] }, { trace: operationTrace })
      assertProtocolFence('session/new response')
      sessionId = assertSessionId(sessionResponse?.sessionId, 'session/new')
    } catch (cause) {
      await persistFailedOperation(operationTrace, 'session/new')
      throw cause
    }
    return fallback
  }
  if (requestedOperation === 'load' && resumeId && canLoad) {
    activeSessionId = resumeId
    line(`[resume] loading ${boundedText(resumeId, '<unknown-session>', MAX_SESSION_ID)} — the agent will replay its history below`)
    setLivenessState('awaiting_agent')
    operationTrace = {}
    operationContext.operationTrace = operationTrace
    try {
      sessionResponse = await request('session/load', { sessionId: resumeId, cwd, mcpServers: [] }, { trace: operationTrace })
      assertProtocolFence('session/load response')
    } catch (cause) {
      await persistFailedOperation(operationTrace, 'session/load')
      throw cause
    }
    // ACP session/load has no sessionId result. The effective semantic id is
    // the exact requested id whose load request received this correlated OK.
    sessionId = resumeId
    line('[resume] history restored — continuing this session')
  } else if (requestedOperation === 'load' && resumeId && !canLoad) {
    console.error(`[resume] ${agentName} does not advertise loadSession — cannot resume ${resumeId}; starting fresh`)
    await startNewSession(true)
  } else {
    await startNewSession(false)
  }
  sessionResponse = await applyRequestedSessionConfig(sessionId, sessionResponse)
  enforceIdentity(sessionResponse)
  activeSessionId = sessionId
  await waitForTestGate('pre-receipt')
  assertProtocolFence('receipt commit')
  line(`[session] ${boundedText(sessionId, '<unknown-session>', MAX_SESSION_ID)}`)
  const performedOperation = requestedOperation === 'load' && canLoad ? 'load' : 'new'
  const operationOutcome = requestedOperation === 'load' && !canLoad ? 'unsupported_fallback' : 'succeeded'
  const operationWitness = performedOperation === 'load' ? 'load_response_for_exact_request' : 'new_session_id_returned'
  const resumeStatus = requestedOperation === 'load'
    ? (performedOperation === 'load' ? 'loaded' : 'unsupported_fallback')
    : 'not_requested'
  await tryPersistOperationReceipt({
    requestedOperation,
    performedOperation,
    operationOutcome,
    requestedResumeSessionId: requestedOperation === 'load' ? resumeId : null,
    effectiveSessionId: sessionId,
    priorReceipt,
    operationWitness,
    operationTrace,
    resumeStatus,
  })
  assertProtocolFence('receipt commit')
  try {
    mkdirSync(sessionsDir, { recursive: true })
    atomicWrite(sessionFile, `${assertSessionId(sessionId, 'session') }\n`)
  } catch (cause) {
    noteError(cause)
    console.error(`[warn] could not persist session id: ${boundedText(cause.message, 'write failed', MAX_ERROR_TEXT)}`)
  }
  clearStaleOutbox()
  assertProtocolFence('recordPrompt')
  recordTestStage('pre-prompt')
  assertProtocolFence('markPromptStarted')
  markPromptStarted()
  const promptDelayMs = nonNegativeNumber(process.env.ACP_TEST_PROMPT_DELAY_MS)
  if (promptDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(promptDelayMs, 5000)))
  assertProtocolFence('session/prompt')
  recordTestStage('prompt')
  const response = await request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: preamble + brief }],
  })
  assertProtocolFence('session/prompt response')
  protocolCompleted = true
  line(`[turn done] stopReason=${boundedText(response?.stopReason, 'unknown')}`)
}

async function main() {
  livenessTimer = setInterval(livenessTick, livenessTickMs)
  if (hardTimeoutMs > 0) hardTimeoutTimer = setTimeout(hardTimeout, hardTimeoutMs)
  try {
    await protocolRun()
    if (protocolFailure) return finishDirectFailure('protocol-error', 'protocol_error', 1)
    if (cancellationActive) return finishCancellation()
    const reaped = await closeAndReapChild({ closeGraceMs: Math.max(processKillGraceMs, processReapGraceMs) })
    if (reaped.forced) return finishDirectFailure('child-unsettled', 'child_unsettled', 1, { settlement: reaped })
    const result = readTerminalOutbox()
    console.log(`[outbox] ${result.outboxPath}`)
    // A DIAGNOSTIC line, written by this process from the file it read, for a
    // person reading the log. It is not an authority and nothing greps it —
    // see the note above `quoteMarkers` for why, and AC130 for the guard. This
    // comment used to say "the ONLY line in this stream that states a verdict"
    // and "a supervisor greps THIS", which is an instruction to build the one
    // reader the contract forbids. Two release lanes found it independently
    // after the same claim had been deleted from the block above; a claim can
    // survive a search for the sentence that expressed it elsewhere.
    console.log(`[terminal] ${result.terminal}${result.terminal === 'invalid' ? ` (last line: "${result.text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1) ?? ''}")` : ''}`)
    // The rule, not just the symptom. A worker reading only the quoted last line
    // cannot learn that the marker must come last, which is how one delivery was
    // retried twice with the same defect (GitHub #53).
    if (result.diagnosis) console.log(`[terminal] ${result.diagnosis}`)
    const exitCode = result.terminal === 'invalid' ? 3 : 0
    return finishTerminal(result.terminal, exitCode, {
      evidencePresent: hasEvidence(result.text),
      settlement: reaped,
      outboxDigest: result.digest,
    })
  } catch (cause) {
    noteError(cause)
    if (controllerInterrupted) await persistInterruptedReceiptIfNeeded()
    else await persistFailureReceiptIfNeeded(cause)
    if (cancellationActive) return finishCancellation()
    codexGuard(`${cause.message}\n${stderrBuf}`)
    console.error(`[fatal] ${cause.message}`)
    if (cause.code === 'identity-missing' || cause.code === 'identity-mismatch') {
      return finishDirectFailure(cause.code, cause.code, 1)
    }
    if (cause.code === 'receipt_persistence_failed' || cause.code === 'receipt_collision'
      || cause.code === 'receipt_correlation_failed') {
      console.error(`[fatal] ${cause.message}`)
      return finishDirectFailure('receipt-persistence-failed', 'receipt_persistence_failed', 1)
    }
    if (unexpectedExit && !agentError) {
      console.error(`[fatal] agent exited early (code ${unexpectedExit.code ?? 'unknown'})`)
      return finishDirectFailure('agent-exit', 'agent_exit', 1, {
        recordExitCode: Number.isInteger(unexpectedExit.code) ? unexpectedExit.code : 1,
      })
    }
    if (agentError) {
      console.error(`[fatal] cannot spawn ${cmd[0]}: ${agentError.message}`)
      return finishDirectFailure('spawn-error', 'spawn_error', 1)
    }
    const terminal = cause.code === 'no_outbox' ? 'no-outbox' : cause.code === 'invalid_outbox' ? 'invalid' : 'protocol-error'
    const exitCode = cause.code === 'no_outbox' || cause.code === 'invalid_outbox' ? 3 : 1
    console.error(`[fatal] ${cause.message}`)
    return finishDirectFailure(terminal, cause.code ?? 'protocol_error', exitCode)
  } finally {
    if (livenessTimer) clearInterval(livenessTimer)
    if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer)
    if (persistenceTimer) clearTimeout(persistenceTimer)
    if (controllerSignalHandlerInstalled) {
      for (const [signal, handler] of controllerSignalHandlers) process.removeListener(signal, handler)
    }
    await killAllLiveTerminals()
  }
}

const exitCode = await main()
process.exitCode = exitCode
