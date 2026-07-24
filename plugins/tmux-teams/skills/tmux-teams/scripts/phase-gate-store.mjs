import { randomBytes } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  PHASE_GATE_JSON_MAX_BYTES,
  PhaseGateValidationError,
  appendPhaseGateEvent,
  createPhaseGateAggregate,
  createPhaseGateManifest,
  replayPhaseGateEvents,
  validatePhaseGateManifest,
} from './phase-gate-core.mjs'
import { canonicalDigest, canonicalJson } from './delivery-loop-core.mjs'

const EVENT_FILE = /^(\d{12})-sha256_([0-9a-f]{64})\.json$/
const RECEIPT_FILE = /^sha256_([0-9a-f]{64})\.json$/
const TEMP_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}\.\d+\.[0-9a-f]{16}\.tmp$/
const ROOT_ENTRIES = new Set(['events', 'locks', 'reconciliations', '.tmp', 'manifest.json', 'head.json'])
const HEAD_KEYS = new Set(['schema', 'schema_version', 'sequence', 'event_id', 'count'])
const LOCK_KEYS = new Set(['schema', 'schema_version', 'owner_token', 'pid', 'ppid', 'boot_id', 'machine_id', 'created_at', 'process_start'])
const error = (code, path, message) => new PhaseGateValidationError([{ code, path, message }], code)
const same = (left, right) => canonicalJson(left) === canonicalJson(right)
const sha = /^sha256:[0-9a-f]{64}$/

function absoluteDir(path, label = 'store') {
  if (typeof path !== 'string' || !isAbsolute(path)) throw error('ABSOLUTE_PATH_REQUIRED', label, 'Path must be absolute.')
  const value = resolve(path)
  if (existsSync(value)) {
    const stat = lstatSync(value)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('DIRECTORY_REQUIRED', value, 'Directory must be a non-symlink directory.')
  }
  return value
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('DIRECTORY_REQUIRED', path, 'Directory must be a non-symlink directory.')
}

function regular(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw error('REGULAR_FILE_REQUIRED', path, 'Entry must be a regular non-symlink file.')
  if (stat.size > PHASE_GATE_JSON_MAX_BYTES) throw error('JSON_TOO_LARGE', path, 'JSON exceeds bound.')
}

function readJson(path) {
  try {
    regular(path)
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    if (cause instanceof PhaseGateValidationError) throw cause
    throw error('JSON_READ_FAILED', path, cause.message)
  }
}

function fsyncDirectory(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch (cause) {
    throw error('DIRECTORY_FSYNC_UNSUPPORTED', path, `Cannot fsync directory: ${cause.code ?? cause.message}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function writeTemp(path, value, stagingDir = resolve(path, '..')) {
  const serialized = canonicalJson(value)
  if (typeof serialized !== 'string'
    || Buffer.byteLength(`${serialized}\n`, 'utf8') > PHASE_GATE_JSON_MAX_BYTES) {
    throw error('JSON_TOO_LARGE', path, 'Canonical JSON exceeds the persisted byte bound.')
  }
  const tmp = join(stagingDir, `${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  let fd
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, `${serialized}\n`)
    fsyncSync(fd)
    closeSync(fd)
    return tmp
  } catch (cause) {
    if (fd !== undefined) try { closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
    throw cause
  }
}

// link(2) makes creation of the final name atomic and truly exclusive.  A
// check-then-rename sequence is intentionally not used.
function createExclusive(path, value, conflictCode = 'STORE_CONFLICT', stagingDir = resolve(path, '..')) {
  const parent = resolve(path, '..')
  const tmp = writeTemp(path, value, stagingDir)
  try {
    linkSync(tmp, path)
    fsyncDirectory(parent)
  } catch (cause) {
    if (cause?.code === 'EEXIST') throw error(conflictCode, path, 'Entry already exists.')
    throw cause
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

function replaceAtomic(path, value, stagingDir = resolve(path, '..')) {
  const parent = resolve(path, '..')
  const tmp = writeTemp(path, value, stagingDir)
  try {
    renameSync(tmp, path)
    fsyncDirectory(parent)
  } catch (cause) {
    try { unlinkSync(tmp) } catch {}
    throw cause
  }
}

function bootIdentity() {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return null }
}

function machineIdentity() {
  try { return readFileSync('/etc/machine-id', 'utf8').trim() } catch { return null }
}

function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    return stat.slice(close + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

function closedObject(value, keys, path, code = 'STORE_INTERNAL_INVALID') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key))
    || [...keys].some((key) => !Object.hasOwn(value, key))) {
    throw error(code, path, 'Object does not match its closed store contract.')
  }
}

function validateHead(head, path) {
  closedObject(head, HEAD_KEYS, path)
  if (head.schema !== 'tmux-teams.phase-gate-head' || head.schema_version !== 1
    || !Number.isInteger(head.count) || head.count < 0
    || !Number.isInteger(head.sequence) || head.sequence !== head.count
    || (head.sequence === 0 ? head.event_id !== null : !sha.test(head.event_id ?? ''))) {
    throw error('STORE_HEAD_INVALID', path, 'Committed head is invalid.')
  }
}

function validateLock(lock, path) {
  closedObject(lock, LOCK_KEYS, path, 'LOCK_INVALID')
  if (lock.schema !== 'tmux-teams.phase-gate-lock' || lock.schema_version !== 1
    || typeof lock.owner_token !== 'string' || !/^[0-9a-f]{48}$/.test(lock.owner_token)
    || !Number.isInteger(lock.pid) || lock.pid < 1 || !Number.isInteger(lock.ppid) || lock.ppid < 0
    || typeof lock.created_at !== 'string' || !Number.isFinite(Date.parse(lock.created_at))
    || !['string', 'object'].includes(typeof lock.boot_id)
    || !['string', 'object'].includes(typeof lock.machine_id)
    || !['string', 'object'].includes(typeof lock.process_start)) {
    throw error('LOCK_INVALID', path, 'Lock metadata is invalid.')
  }
}

function validateNamespaces(store) {
  const rootEntries = readdirSync(store)
  if (rootEntries.some((name) => !ROOT_ENTRIES.has(name))) throw error('FOREIGN_ENTRY', store, 'Store root contains a foreign entry.')
  for (const name of ['events', 'locks', 'reconciliations', '.tmp']) {
    const path = join(store, name)
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('DIRECTORY_REQUIRED', path, 'Store namespace must be a non-symlink directory.')
  }
  const lockNames = readdirSync(join(store, 'locks'))
  if (lockNames.some((name) => name !== 'store.lock')) throw error('FOREIGN_ENTRY', join(store, 'locks'), 'Locks namespace contains a foreign entry.')
  const staging = join(store, '.tmp')
  const tempNames = readdirSync(staging)
  for (const name of tempNames) {
    if (!TEMP_FILE.test(name)) throw error('FOREIGN_ENTRY', staging, 'Staging namespace contains a foreign entry.')
    try {
      regular(join(staging, name))
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause
    }
  }
  const receiptNames = readdirSync(join(store, 'reconciliations'))
  if (receiptNames.some((name) => !RECEIPT_FILE.test(name))) throw error('FOREIGN_ENTRY', join(store, 'reconciliations'), 'Reconciliation namespace contains a foreign entry.')
  for (const name of receiptNames) {
    const receipt = readJson(join(store, 'reconciliations', name))
    if (canonicalDigest(receipt).slice('sha256:'.length) !== RECEIPT_FILE.exec(name)[1]) {
      throw error('RECONCILIATION_DIGEST_MISMATCH', join(store, 'reconciliations', name), 'Reconciliation filename does not bind its immutable body.')
    }
  }
}

function storeSkeleton(storeDir) {
  const store = absoluteDir(storeDir)
  ensureDirectory(store)
  for (const name of ['events', 'locks', 'reconciliations', '.tmp']) ensureDirectory(join(store, name))
  return store
}

export function inspectPhaseGateLock(storeDir) {
  const store = absoluteDir(storeDir)
  const path = join(store, 'locks', 'store.lock')
  if (!existsSync(path)) return null
  const lock = readJson(path)
  validateLock(lock, path)
  return lock
}

export function acquirePhaseGateLock(storeDir, { owner_token = randomBytes(24).toString('hex'), pid = process.pid } = {}) {
  const store = absoluteDir(storeDir)
  const locks = join(store, 'locks')
  const staging = join(store, '.tmp')
  ensureDirectory(locks)
  ensureDirectory(staging)
  const path = join(locks, 'store.lock')
  const lock = {
    schema: 'tmux-teams.phase-gate-lock',
    schema_version: 1,
    owner_token,
    pid,
    ppid: process.ppid,
    boot_id: bootIdentity(),
    machine_id: machineIdentity(),
    created_at: new Date().toISOString(),
    process_start: processStart(pid),
  }
  validateLock(lock, path)
  try {
    createExclusive(path, lock, 'STORE_BUSY', staging)
  } catch (cause) {
    if (cause?.code === 'STORE_BUSY') throw error('STORE_BUSY', path, 'Lock exists; inspect and explicitly reconcile it.')
    throw cause
  }
  let released = false
  return {
    lock,
    release() {
      if (released) return
      const current = readJson(path)
      validateLock(current, path)
      if (!same(current, lock)) throw error('LOCK_OWNER_MISMATCH', path, 'Refusing to release another owner lock.')
      unlinkSync(path)
      fsyncDirectory(locks)
      released = true
    },
  }
}

function authorizedPm(manifest, actorId) {
  return typeof actorId === 'string' && manifest.actors.pm.includes(actorId)
}

function lockIsLive(lock) {
  return lock.boot_id === bootIdentity()
    && lock.machine_id === machineIdentity()
    && processStart(lock.pid) !== null
    && processStart(lock.pid) === lock.process_start
}

function writeReceipt(store, body) {
  const receipt = {
    schema: 'tmux-teams.phase-gate-reconciliation',
    schema_version: 1,
    ...body,
  }
  const receiptId = canonicalDigest(receipt)
  const path = join(store, 'reconciliations', `${receiptId.replace(':', '_')}.json`)
  if (existsSync(path)) {
    const existing = readJson(path)
    if (!same(existing, receipt)) throw error('RECONCILIATION_CONFLICT', path, 'Receipt id is bound to different content.')
    return { receipt_id: receiptId, receipt: existing }
  }
  createExclusive(path, receipt, 'STORE_CONFLICT', join(store, '.tmp'))
  return { receipt_id: receiptId, receipt }
}

export function manualReconcilePhaseGateLock(storeDir, {
  observed_lock,
  observed_head,
  reason,
  authorized_actor,
  occurred_at = new Date().toISOString(),
} = {}) {
  const store = absoluteDir(storeDir)
  validateNamespaces(store)
  const manifest = readJson(join(store, 'manifest.json'))
  const manifestValidation = validatePhaseGateManifest(manifest)
  if (!manifestValidation.valid) throw new PhaseGateValidationError(manifestValidation.errors)
  if (!authorizedPm(manifest, authorized_actor)) throw error('RECONCILIATION_UNAUTHORIZED', 'authorized_actor', 'A frozen manifest PM actor is required.')
  if (typeof reason !== 'string' || reason.length < 8 || reason.length > 1024) throw error('RECONCILIATION_REASON_REQUIRED', 'reason', 'A bounded explicit reason is required.')
  if (!Number.isFinite(Date.parse(occurred_at))) throw error('RECONCILIATION_TIME_INVALID', 'occurred_at', 'occurred_at must be RFC3339.')
  const headPath = join(store, 'head.json')
  const currentHead = readJson(headPath)
  validateHead(currentHead, headPath)
  if (!same(currentHead, observed_head)) throw error('OBSERVED_HEAD_MISMATCH', 'observed_head', 'Committed head changed after observation.')
  const lockPath = join(store, 'locks', 'store.lock')
  if (!existsSync(lockPath)) throw error('LOCK_OBSERVATION_MISMATCH', 'observed_lock', 'Observed lock no longer exists.')
  const currentLock = readJson(lockPath)
  validateLock(currentLock, lockPath)
  if (!same(currentLock, observed_lock)) throw error('LOCK_OBSERVATION_MISMATCH', 'observed_lock', 'Lock changed after observation.')
  if (lockIsLive(currentLock)) throw error('LOCK_OWNER_LIVE', lockPath, 'Refusing to reconcile a lock whose exact process identity is live.')
  const result = writeReceipt(store, {
    kind: 'stale_lock_release',
    occurred_at,
    reason,
    authorized_actor,
    observed_lock: currentLock,
    observed_head: currentHead,
  })
  unlinkSync(lockPath)
  fsyncDirectory(join(store, 'locks'))
  return { reconciled: true, ...result }
}

export function initializePhaseGateStore(storeDir, manifestInput) {
  const store = storeSkeleton(storeDir)
  const staging = join(store, '.tmp')
  const manifest = createPhaseGateManifest(manifestInput)
  const manifestPath = join(store, 'manifest.json')
  if (existsSync(manifestPath)) {
    const old = readJson(manifestPath)
    if (!same(old, manifest)) throw error('MANIFEST_CONFLICT', manifestPath, 'Immutable store manifest differs.')
  } else {
    createExclusive(manifestPath, manifest, 'STORE_CONFLICT', staging)
  }
  const headPath = join(store, 'head.json')
  const emptyHead = { schema: 'tmux-teams.phase-gate-head', schema_version: 1, sequence: 0, event_id: null, count: 0 }
  if (existsSync(headPath)) {
    const head = readJson(headPath)
    validateHead(head, headPath)
  } else {
    createExclusive(headPath, emptyHead, 'STORE_CONFLICT', staging)
  }
  validateNamespaces(store)
  fsyncDirectory(store)
  return { store, manifest }
}

function readEventFiles(store) {
  const eventsDir = join(store, 'events')
  const names = readdirSync(eventsDir)
  if (names.some((name) => !EVENT_FILE.test(name))) throw error('FOREIGN_ENTRY', eventsDir, 'Events namespace contains a foreign entry.')
  return names.sort().map((name, index) => {
    const match = EVENT_FILE.exec(name)
    const event = readJson(join(eventsDir, name))
    const expectedSequence = index + 1
    if (Number(match[1]) !== expectedSequence || event.sequence !== expectedSequence
      || event.event_id !== `sha256:${match[2]}`) {
      throw error('EVENT_FILENAME_MISMATCH', join(eventsDir, name), 'Event filename does not bind its sequence and digest.')
    }
    return event
  })
}

function readRawStore(storeDir) {
  const store = absoluteDir(storeDir)
  validateNamespaces(store)
  const manifest = readJson(join(store, 'manifest.json'))
  const manifestValidation = validatePhaseGateManifest(manifest)
  if (!manifestValidation.valid) throw new PhaseGateValidationError(manifestValidation.errors)
  const head = readJson(join(store, 'head.json'))
  validateHead(head, join(store, 'head.json'))
  const events = readEventFiles(store)
  const aggregate = replayPhaseGateEvents(createPhaseGateAggregate(manifest), events)
  return { store, manifest, head, events, aggregate }
}

export function readPhaseGateStore(storeDir) {
  const result = readRawStore(storeDir)
  const { store, head, events, aggregate } = result
  const last = events.at(-1)
  if (events.length !== head.count
    || (events.length
      ? last.event_id !== head.event_id || last.sequence !== head.sequence
      : head.event_id !== null || head.sequence !== 0)
    || !same(aggregate.head, { sequence: head.sequence, event_id: head.event_id })) {
    throw error('COMMITTED_HEAD_MISMATCH', join(store, 'head.json'), 'Tail/full deletion, insertion, changed body, or interrupted head commit detected.')
  }
  return result
}

export function appendPhaseGateEventAtomic(storeDir, event, { expected_head } = {}) {
  if (!expected_head) throw error('EXPECTED_HEAD_REQUIRED', 'expected_head', 'Caller must supply the observed aggregate head.')
  const store = absoluteDir(storeDir)
  const staging = join(store, '.tmp')
  const lock = acquirePhaseGateLock(store)
  try {
    const current = readPhaseGateStore(store)
    const next = appendPhaseGateEvent(current.aggregate, event, { expected_head })
    if (!next.appended) return next
    const digest = next.event.event_id.slice('sha256:'.length)
    const file = join(store, 'events', `${String(next.event.sequence).padStart(12, '0')}-sha256_${digest}.json`)
    createExclusive(file, next.event, 'STORE_CONFLICT', staging)
    replaceAtomic(join(store, 'head.json'), {
      schema: 'tmux-teams.phase-gate-head',
      schema_version: 1,
      sequence: next.aggregate.head.sequence,
      event_id: next.aggregate.head.event_id,
      count: next.aggregate.events.length,
    }, staging)
    return next
  } finally {
    lock.release()
  }
}

// Recover only the single safe crash shape: one fully written, valid event
// extends the still-committed head.  No event is deleted or rewritten.
export function manualReconcilePhaseGateStore(storeDir, {
  observed_lock,
  observed_head,
  reason,
  authorized_actor,
  occurred_at = new Date().toISOString(),
} = {}) {
  const store = absoluteDir(storeDir)
  validateNamespaces(store)
  const manifest = readJson(join(store, 'manifest.json'))
  const manifestValidation = validatePhaseGateManifest(manifest)
  if (!manifestValidation.valid) throw new PhaseGateValidationError(manifestValidation.errors)
  if (!authorizedPm(manifest, authorized_actor)) throw error('RECONCILIATION_UNAUTHORIZED', 'authorized_actor', 'A frozen manifest PM actor is required.')
  if (typeof reason !== 'string' || reason.length < 8 || reason.length > 1024) throw error('RECONCILIATION_REASON_REQUIRED', 'reason', 'A bounded explicit reason is required.')
  if (!Number.isFinite(Date.parse(occurred_at))) throw error('RECONCILIATION_TIME_INVALID', 'occurred_at', 'occurred_at must be RFC3339.')
  const currentLock = inspectPhaseGateLock(store)
  if (!same(currentLock, observed_lock ?? null)) throw error('LOCK_OBSERVATION_MISMATCH', 'observed_lock', 'Lock state changed after observation.')
  if (currentLock !== null) throw error('STORE_BUSY', join(store, 'locks', 'store.lock'), 'Reconcile the observed stale lock first.')
  const lock = acquirePhaseGateLock(store)
  try {
    const headPath = join(store, 'head.json')
    const currentHead = readJson(headPath)
    validateHead(currentHead, headPath)
    if (!same(currentHead, observed_head)) throw error('OBSERVED_HEAD_MISMATCH', 'observed_head', 'Committed head changed after observation.')
    const events = readEventFiles(store)
    if (events.length !== currentHead.count + 1) throw error('RECONCILIATION_SHAPE_UNSAFE', 'events', 'Only one orphan event beyond the observed committed head can be reconciled.')
    if (currentHead.count > 0) {
      const committed = events[currentHead.count - 1]
      if (committed.event_id !== currentHead.event_id || committed.sequence !== currentHead.sequence) {
        throw error('RECONCILIATION_PREFIX_MISMATCH', 'events', 'Observed committed prefix does not match the ledger.')
      }
    } else if (currentHead.event_id !== null || currentHead.sequence !== 0) {
      throw error('RECONCILIATION_PREFIX_MISMATCH', 'events', 'Empty committed prefix is invalid.')
    }
    const aggregate = replayPhaseGateEvents(createPhaseGateAggregate(manifest), events)
    const result = writeReceipt(store, {
      kind: 'orphan_event_head_advance',
      occurred_at,
      reason,
      authorized_actor,
      observed_lock: null,
      observed_head: currentHead,
      recovered_event_id: aggregate.head.event_id,
    })
    replaceAtomic(headPath, {
      schema: 'tmux-teams.phase-gate-head',
      schema_version: 1,
      sequence: aggregate.head.sequence,
      event_id: aggregate.head.event_id,
      count: events.length,
    }, join(store, '.tmp'))
    return { reconciled: true, aggregate, ...result }
  } finally {
    lock.release()
  }
}
