import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

import {
  PilotValidationError,
  appendPilotEvent,
  validateFrozenManifest,
} from './delivery-loop-pilot-core.mjs'

const MAX_JSON_BYTES = 4 * 1024 * 1024
const DIGEST_RE = /^sha256:([0-9a-f]{64})$/

function storeError(code, message, path = '') {
  return new PilotValidationError([{ code, path, message }], code)
}

export function requireAbsoluteDir(path, label = 'directory') {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw storeError('ABSOLUTE_PATH_REQUIRED', `${label} must be an absolute path.`, label)
  }
  const resolved = resolve(path)
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storeError('DIRECTORY_REQUIRED', `${label} must be a non-symlink directory.`, label)
    }
  }
  return resolved
}

export function readBoundedFile(path, maxBytes = MAX_JSON_BYTES) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw storeError('REGULAR_FILE_REQUIRED', `${path} must be a regular non-symlink file.`, path)
  }
  if (stat.size > maxBytes) throw storeError('SOURCE_TOO_LARGE', `${path} exceeds ${maxBytes} bytes.`, path)
  return readFileSync(path)
}

export function readJsonFile(path) {
  let parsed
  try {
    parsed = JSON.parse(readBoundedFile(path).toString('utf8'))
  } catch (error) {
    if (error instanceof PilotValidationError) throw error
    throw storeError('JSON_READ_FAILED', `Cannot read ${basename(path)}: ${error.message}`, path)
  }
  return parsed
}

function atomicWrite(path, content, { exclusive = false } = {}) {
  const temp = `${path}.${process.pid}.tmp`
  let descriptor = null
  try {
    descriptor = openSync(temp, 'wx', 0o600)
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    if (exclusive) {
      try {
        linkSync(temp, path)
        rmSync(temp)
      } catch (error) {
        if (error.code === 'EEXIST') throw storeError('STORE_CONFLICT', `${basename(path)} already exists.`, path)
        throw error
      }
    } else {
      renameSync(temp, path)
    }
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    try { rmSync(temp) } catch { /* best effort */ }
    throw error
  }
}

export function initializeStore(storeDir, manifest) {
  const store = requireAbsoluteDir(storeDir, 'store')
  const validation = validateFrozenManifest(manifest)
  if (!validation.valid) throw new PilotValidationError(validation.errors)
  mkdirSync(store, { recursive: true, mode: 0o700 })
  const manifestPath = join(store, 'manifest.json')
  if (existsSync(manifestPath)) {
    const existing = readJsonFile(manifestPath)
    if (existing.manifest_digest === manifest.manifest_digest) return { store, created: false }
    throw storeError('MANIFEST_ALREADY_FROZEN', 'Store already contains a different frozen manifest.', manifestPath)
  }
  mkdirSync(join(store, 'events'), { recursive: true, mode: 0o700 })
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { exclusive: true })
  return { store, created: true }
}

export function readStore(storeDir) {
  const store = requireAbsoluteDir(storeDir, 'store')
  const manifest = readJsonFile(join(store, 'manifest.json'))
  const validation = validateFrozenManifest(manifest)
  if (!validation.valid) throw new PilotValidationError(validation.errors)
  const eventsDir = join(store, 'events')
  const events = existsSync(eventsDir)
    ? readdirSync(eventsDir)
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
      .sort()
      .map((name) => readJsonFile(join(eventsDir, name)))
    : []
  return { store, manifest, events }
}

function withAppendLock(store, operation) {
  const lock = join(store, '.append.lock')
  try {
    mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') throw storeError('STORE_BUSY', 'Another append operation owns the store lock.', lock)
    throw error
  }
  try {
    return operation()
  } finally {
    try { rmSync(lock, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

export function appendEventAtomic(storeDir, event) {
  const store = requireAbsoluteDir(storeDir, 'store')
  return withAppendLock(store, () => {
    const { manifest, events } = readStore(store)
    const next = appendPilotEvent(manifest, events, event)
    if (next.length === events.length) return { event, appended: false }
    const match = DIGEST_RE.exec(event.event_id)
    if (!match) throw storeError('EVENT_ID_INVALID', 'Event ID must be a SHA-256 digest.', 'event.event_id')
    const eventsDir = join(store, 'events')
    mkdirSync(eventsDir, { recursive: true, mode: 0o700 })
    const eventPath = join(eventsDir, `${match[1]}.json`)
    if (existsSync(eventPath)) {
      const existing = readJsonFile(eventPath)
      if (JSON.stringify(existing) === JSON.stringify(event)) return { event: existing, appended: false }
      throw storeError('EVENT_FILE_CONFLICT', 'Event file already binds different content.', eventPath)
    }
    atomicWrite(eventPath, `${JSON.stringify(event, null, 2)}\n`, { exclusive: true })
    return { event, appended: true }
  })
}

export function writeJsonAtomic(path, value, { exclusive = false } = {}) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, { exclusive })
}
