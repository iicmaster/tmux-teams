import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  PHASE_GATE_EVENTS,
  PHASE_GATE_JSON_MAX_BYTES,
  PHASE_GATE_TRUST_LEVEL,
  REQUIREMENT_BOOTSTRAP_BOUNDARY,
  appendPhaseGateEvent,
  canonicalRepoIdentity,
  stablePhaseRunId,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-core.mjs'
import {
  acquirePhaseGateLock,
  appendPhaseGateEventAtomic,
  initializePhaseGateStore,
  inspectPhaseGateLock,
  manualReconcilePhaseGateLock,
  manualReconcilePhaseGateStore,
  readPhaseGateStore,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-store.mjs'
import { canonicalDigest } from '../plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'phase-gate-store-process-driver.mjs')
const actors = {
  pm: ['pm-1'],
  phase_leads: {
    Requirement: ['requirement-lead'],
    Prototype: ['prototype-lead'],
    Development: ['development-lead'],
    QA: ['qa-lead'],
    ProjectDelivery: ['delivery-lead'],
  },
}
const manifest = (overrides = {}) => ({
  project_run_id: 'project',
  slice_id: 'slice',
  repo_root: '/workspace/project',
  repo_identity_digest: canonicalRepoIdentity('/workspace/project'),
  actors,
  trust_level: PHASE_GATE_TRUST_LEVEL,
  ...overrides,
})
const phaseRun = (phase) => stablePhaseRunId('slice', phase)
const genesis = (overrides = {}) => ({
  project_run_id: 'project',
  slice_id: 'slice',
  phase_run_id: phaseRun('Requirement'),
  occurred_at: '2026-07-24T00:00:01.000Z',
  actor: { actor_id: 'pm-1', role: 'pm', trust: PHASE_GATE_TRUST_LEVEL },
  command_id: 'genesis',
  idempotency_key: 'genesis',
  event_type: 'project_genesis',
  payload: { initial_phase: 'Requirement' },
  ...overrides,
})
const bootstrapReservation = (head, overrides = {}) => ({
  project_run_id: 'project',
  slice_id: 'slice',
  phase_run_id: phaseRun('Requirement'),
  occurred_at: '2026-07-24T00:00:02.000Z',
  boundary: REQUIREMENT_BOOTSTRAP_BOUNDARY,
  dispatch_uuid: '123e4567-e89b-42d3-a456-426614174001',
  acceptance_event_id: null,
  actor: { actor_id: 'requirement-lead', role: 'receiver_phase_lead', trust: PHASE_GATE_TRUST_LEVEL },
  command_id: 'bootstrap-reservation',
  idempotency_key: 'bootstrap-reservation',
  event_type: 'dispatch_reservation',
  payload: {
    bootstrap: true,
    task_id: 'requirement-bootstrap',
    agent_id: 'requirement-lead',
    brief_digest: canonicalDigest({ brief: 'bootstrap' }),
    expected_head: head,
    trust_level: PHASE_GATE_TRUST_LEVEL,
    timeout_sec: 300,
  },
  ...overrides,
})
const makeStore = () => {
  const store = mkdtempSync(join(tmpdir(), 'phase-gate-'))
  initializePhaseGateStore(store, manifest())
  return store
}
const eventNames = (store) => readdirSync(join(store, 'events')).sort()

test('store preserves immutable manifest/head, deterministic idempotency, and stale-head exclusion', () => {
  const store = makeStore()
  try {
    const empty = readPhaseGateStore(store)
    const first = appendPhaseGateEventAtomic(store, genesis(), { expected_head: empty.aggregate.head })
    assert.equal(first.appended, true)
    const replay = appendPhaseGateEventAtomic(store, genesis(), { expected_head: empty.aggregate.head })
    assert.equal(replay.appended, false)
    assert.equal(replay.event.event_id, first.event.event_id)
    assert.equal(readPhaseGateStore(store).head.count, 1)
    assert.throws(() => appendPhaseGateEventAtomic(store, genesis({
      payload: { initial_phase: 'Requirement', injected: true },
    }), { expected_head: first.aggregate.head }), (cause) => cause.code === 'IDEMPOTENCY_CONFLICT')
    assert.throws(() => appendPhaseGateEventAtomic(store, bootstrapReservation(empty.aggregate.head), {
      expected_head: empty.aggregate.head,
    }), (cause) => cause.code === 'HEAD_CONFLICT')
    assert.throws(() => initializePhaseGateStore(store, manifest({ slice_id: 'different-slice' })), (cause) => cause.code === 'MANIFEST_CONFLICT')
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})

test('invalid/unauthorized command and removed denial event do not advance operational head', () => {
  const store = makeStore()
  try {
    const before = readPhaseGateStore(store)
    assert.equal(PHASE_GATE_EVENTS.includes('denial_audit'), false)
    assert.throws(() => appendPhaseGateEventAtomic(store, genesis({
      actor: { actor_id: 'attacker', role: 'pm', trust: PHASE_GATE_TRUST_LEVEL },
    }), { expected_head: before.aggregate.head }), (cause) => cause.errors.some((item) => item.code === 'ACTOR_UNAUTHORIZED'))
    const after = readPhaseGateStore(store)
    assert.deepEqual(after.head, before.head)
    assert.equal(after.events.length, 0)
    assert.equal(inspectPhaseGateLock(store), null)
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})

test('oversized canonical event is rejected before persistence and leaves head/events unchanged', () => {
  const store = makeStore()
  try {
    const before = readPhaseGateStore(store)
    const beforeNames = eventNames(store)
    assert.throws(() => appendPhaseGateEventAtomic(store, genesis({
      idempotency_key: `oversized-${'x'.repeat(PHASE_GATE_JSON_MAX_BYTES)}`,
    }), { expected_head: before.aggregate.head }), (cause) =>
      cause.errors?.some((item) => item.code === 'EVENT_JSON_TOO_LARGE'))
    const after = readPhaseGateStore(store)
    assert.deepEqual(after.head, before.head)
    assert.deepEqual(eventNames(store), beforeNames)
    assert.equal(after.events.length, 0)
    assert.equal(inspectPhaseGateLock(store), null)
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})

test('tail/full deletion and changed event body are detected against committed head and hash chain', () => {
  for (const mode of ['tail', 'full', 'changed']) {
    const store = makeStore()
    try {
      let snapshot = readPhaseGateStore(store)
      appendPhaseGateEventAtomic(store, genesis(), { expected_head: snapshot.aggregate.head })
      snapshot = readPhaseGateStore(store)
      appendPhaseGateEventAtomic(store, bootstrapReservation(snapshot.aggregate.head), { expected_head: snapshot.aggregate.head })
      const names = eventNames(store)
      if (mode === 'tail') rmSync(join(store, 'events', names.at(-1)))
      if (mode === 'full') for (const name of names) rmSync(join(store, 'events', name))
      if (mode === 'changed') {
        const path = join(store, 'events', names[0])
        const event = JSON.parse(readFileSync(path, 'utf8'))
        event.payload.initial_phase = 'Prototype'
        writeFileSync(path, `${JSON.stringify(event)}\n`)
      }
      assert.throws(() => readPhaseGateStore(store), (cause) => ['COMMITTED_HEAD_MISMATCH', 'PHASE_GATE_VALIDATION_FAILED'].includes(cause.code))
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  }
})

test('a live unrelated lock never masks committed tail deletion as ordinary writer contention', () => {
  const store = makeStore()
  let held
  try {
    const empty = readPhaseGateStore(store)
    appendPhaseGateEventAtomic(store, genesis(), { expected_head: empty.aggregate.head })
    held = acquirePhaseGateLock(store)
    rmSync(join(store, 'events', eventNames(store).at(-1)))
    assert.throws(() => readPhaseGateStore(store), (cause) => cause.code === 'COMMITTED_HEAD_MISMATCH')
  } finally {
    try { held?.release() } catch {}
    rmSync(store, { recursive: true, force: true })
  }
})

test('foreign and symlink entries fail closed in store namespaces', () => {
  for (const placement of ['root', 'events-symlink']) {
    const store = makeStore()
    try {
      if (placement === 'root') writeFileSync(join(store, 'foreign.txt'), 'foreign')
      else symlinkSync('/etc/hosts', join(store, 'events', '000000000001-sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'))
      assert.throws(() => readPhaseGateStore(store), (cause) => ['FOREIGN_ENTRY', 'REGULAR_FILE_REQUIRED'].includes(cause.code))
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  }
})

test('true multi-process lock contention uses an exclusive Linux final-name create', async () => {
  const store = makeStore()
  const child = spawn(process.execPath, [fixture, store], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const ready = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`fixture timeout: ${output}`)), 5000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.includes('"ready":true')) {
          clearTimeout(timer)
          resolve(output)
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`fixture exited before ready: ${code}`))
      })
    })
    assert.match(ready, /"ready":true/)
    assert.throws(() => acquirePhaseGateLock(store), (cause) => cause.code === 'STORE_BUSY')
    assert.ok(inspectPhaseGateLock(store))
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    rmSync(store, { recursive: true, force: true })
  }
})

test('the staging namespace isolates in-flight writes without weakening canonical namespaces', () => {
  const store = makeStore()
  const held = acquirePhaseGateLock(store)
  const locks = join(store, 'locks')
  const transient = join(store, '.tmp', `head.json.${process.pid}.${'a'.repeat(16)}.tmp`)
  const foreign = join(locks, `store.lock.${process.pid}.${'b'.repeat(16)}.tmp`)
  const stagedSymlink = join(store, '.tmp', `head.json.${process.pid}.${'c'.repeat(16)}.tmp`)
  try {
    writeFileSync(transient, 'losing writer temp')
    assert.doesNotThrow(() => readPhaseGateStore(store))
    symlinkSync('/etc/hosts', stagedSymlink)
    assert.throws(() => readPhaseGateStore(store), (cause) => cause.code === 'REGULAR_FILE_REQUIRED')
    rmSync(stagedSymlink)
    writeFileSync(foreign, 'foreign')
    assert.throws(() => readPhaseGateStore(store), (cause) => cause.code === 'FOREIGN_ENTRY')
    rmSync(foreign)
    held.release()
    assert.doesNotThrow(() => readPhaseGateStore(store))
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})

test('stale lock reconciliation requires exact observed lock/head, reason, and manifest PM', () => {
  const store = makeStore()
  try {
    const held = acquirePhaseGateLock(store, { pid: 999999 })
    const observed_lock = inspectPhaseGateLock(store)
    const observed_head = readPhaseGateStore(store).head
    assert.throws(() => manualReconcilePhaseGateLock(store, {
      observed_lock,
      observed_head,
      reason: 'verified abandoned process',
      authorized_actor: 'attacker',
    }), (cause) => cause.code === 'RECONCILIATION_UNAUTHORIZED')
    assert.throws(() => manualReconcilePhaseGateLock(store, {
      observed_lock: { ...observed_lock, pid: 1 },
      observed_head,
      reason: 'verified abandoned process',
      authorized_actor: 'pm-1',
    }), (cause) => cause.code === 'LOCK_OBSERVATION_MISMATCH')
    const result = manualReconcilePhaseGateLock(store, {
      observed_lock,
      observed_head,
      reason: 'verified abandoned process',
      authorized_actor: 'pm-1',
      occurred_at: '2026-07-24T00:10:00.000Z',
    })
    assert.equal(result.reconciled, true)
    assert.equal(inspectPhaseGateLock(store), null)
    assert.equal(readdirSync(join(store, 'reconciliations')).length, 1)
    // The original handle cannot delete any future lock after reconciliation.
    assert.throws(() => held.release(), (cause) => ['JSON_READ_FAILED', 'LOCK_OWNER_MISMATCH'].includes(cause.code))
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})

test('manual store reconciliation only advances head over one valid orphan event and never rewrites the ledger', () => {
  const store = makeStore()
  try {
    let snapshot = readPhaseGateStore(store)
    const next = appendPhaseGateEvent(snapshot.aggregate, genesis(), { expected_head: snapshot.aggregate.head })
    const digest = next.event.event_id.slice('sha256:'.length)
    const filename = `${String(next.event.sequence).padStart(12, '0')}-sha256_${digest}.json`
    const held = acquirePhaseGateLock(store)
    writeFileSync(join(store, 'events', filename), `${JSON.stringify(next.event)}\n`, { flag: 'wx', mode: 0o600 })
    assert.throws(() => readPhaseGateStore(store), (cause) => cause.code === 'STORE_BUSY')
    held.release()
    assert.throws(() => readPhaseGateStore(store), (cause) => cause.code === 'COMMITTED_HEAD_MISMATCH')
    const recovered = manualReconcilePhaseGateStore(store, {
      observed_lock: null,
      observed_head: snapshot.head,
      reason: 'event fsync completed before interrupted head replace',
      authorized_actor: 'pm-1',
      occurred_at: '2026-07-24T00:20:00.000Z',
    })
    assert.equal(recovered.reconciled, true)
    snapshot = readPhaseGateStore(store)
    assert.equal(snapshot.head.count, 1)
    assert.equal(snapshot.events[0].event_id, next.event.event_id)
    assert.equal(readdirSync(join(store, 'reconciliations')).length, 1)
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})
