#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  EVENT_SCHEMA_VERSION,
  PilotValidationError,
} from './delivery-loop-pilot-core.mjs'
import {
  appendEventAtomic,
  readBoundedFile,
  readJsonFile,
  readStore,
} from './delivery-loop-store.mjs'
import { canonicalDigest } from './delivery-loop-core.mjs'

const EVENT_SCHEMA = ['t', 'mux-teams.delivery-loop-event'].join('')
const KINDS = new Set(['mailbox-dispatch', 'mailbox-outbox', 'kms-event'])
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

function captureError(code, message, path = '') {
  return new PilotValidationError([{ code, path, message }], code)
}

function field(text, name) {
  const match = text.match(new RegExp(`^${name}:[ \\t]*([^\\r\\n]{1,256})$`, 'm'))
  return match?.[1]?.trim() ?? null
}

function lastNonEmptyLine(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? ''
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function inspectNamedSource({ kind, sourcePath, correlationId }) {
  if (!KINDS.has(kind)) throw captureError('CAPTURE_KIND_INVALID', 'Named source kind is not supported.', 'kind')
  const bytes = readBoundedFile(sourcePath, 1024 * 1024)
  const text = bytes.toString('utf8')
  let signal
  let correlation = correlationId
  if (kind === 'mailbox-dispatch') {
    signal = 'DISPATCH_RECORDED'
    correlation ??= field(text, 'dispatch_id')
    if (!field(text, 'task_id') || !field(text, 'worker') || !field(text, 'started_at')) {
      throw captureError('DISPATCH_SOURCE_INVALID', 'Dispatch record is missing required named fields.', sourcePath)
    }
  } else if (kind === 'mailbox-outbox') {
    const terminal = /^TEAM_(DONE|BLOCKED|FAILED) ([A-Za-z0-9_][A-Za-z0-9_-]{0,63})$/.exec(lastNonEmptyLine(text))
    if (!terminal) throw captureError('OUTBOX_SOURCE_INVALID', 'Outbox final line is not a typed terminal marker.', sourcePath)
    signal = {
      DONE: 'WORKER_TERMINAL_DONE',
      BLOCKED: 'WORKER_TERMINAL_BLOCKED',
      FAILED: 'WORKER_TERMINAL_FAILED',
    }[terminal[1]]
    if (!correlation) {
      throw captureError('STRONG_CORRELATION_REQUIRED', 'Outbox capture requires an explicit dispatch correlation ID.', 'correlationId')
    }
  } else {
    const verdict = field(text, 'pm_verdict')
    signal = {
      pass: 'PM_VERDICT_PASS',
      reject: 'PM_VERDICT_REJECT',
      unresolved: 'PM_VERDICT_UNRESOLVED',
    }[verdict]
    correlation ??= field(text, 'dispatch_id')
    if (!signal) throw captureError('KMS_SOURCE_INVALID', 'KMS event has no closed PM verdict.', sourcePath)
  }
  if (typeof correlation !== 'string' || !ID_RE.test(correlation)) {
    throw captureError('STRONG_CORRELATION_REQUIRED', 'A validated dispatch correlation ID is required.', 'correlationId')
  }
  return {
    kind,
    signal,
    correlation_id: correlation,
    source_digest: digestBytes(bytes),
    source_ref: `named:${kind}:${basename(sourcePath).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80)}`,
  }
}

export function captureNamedSource({
  kind,
  sourcePath,
  storeDir,
  sliceId,
  actorId,
  actorRole = 'pm',
  occurredAt,
  correlationId,
}) {
  if (!ID_RE.test(sliceId ?? '')) throw captureError('SLICE_ID_INVALID', 'A validated slice ID is required.', 'sliceId')
  const receipt = inspectNamedSource({ kind, sourcePath, correlationId })
  const { manifest } = readStore(storeDir)
  const aggregateId = `source-${receipt.source_digest.slice(-24)}`
  const payload = {
    slice_id: sliceId,
    signal: receipt.signal,
    correlation_id: receipt.correlation_id,
  }
  const unsigned = {
    schema: EVENT_SCHEMA,
    schema_version: EVENT_SCHEMA_VERSION,
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    aggregate: {
      type: 'observation',
      id: aggregateId,
      sequence: 1,
      previous_event_id: null,
    },
    event_type: 'source_observed',
    occurred_at: occurredAt,
    claimed_actor: { actor_id: actorId, role: actorRole },
    source: {
      kind: {
        'mailbox-dispatch': 'mailbox_dispatch',
        'mailbox-outbox': 'mailbox_outbox',
        'kms-event': 'kms_event',
      }[kind],
      source_ref: receipt.source_ref,
      source_digest: receipt.source_digest,
      trust_level: 'advisory_same_uid',
    },
    payload,
  }
  const event = { ...unsigned, event_id: canonicalDigest(unsigned) }
  const result = appendEventAtomic(storeDir, event)
  return { ...result, receipt }
}

export function captureObservation({ eventPath, storeDir }) {
  const event = readJsonFile(eventPath)
  const result = appendEventAtomic(storeDir, event)
  return { event: result.event, appended: result.appended }
}

function flag(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

function usage() {
  return [
    'usage:',
    '  delivery-loop-capture.mjs capture <mailbox-dispatch|mailbox-outbox|kms-event> <source> --store <absolute-dir> --slice <id> --actor <id> --at <RFC3339> [--role pm|metric_producer] [--correlation <dispatch-id>]',
    '  delivery-loop-capture.mjs observation <event.json> --store <absolute-dir>',
  ].join('\n')
}

async function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const [command, kind, sourcePath, ...args] = argv
  if (command === 'observation' && kind) {
    const result = captureObservation({
      eventPath: kind,
      storeDir: flag([sourcePath, ...args].filter((value) => value !== undefined), '--store'),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (command !== 'capture' || !kind || !sourcePath) throw captureError('USAGE', usage())
  const result = captureNamedSource({
    kind,
    sourcePath,
    storeDir: flag(args, '--store'),
    sliceId: flag(args, '--slice'),
    actorId: flag(args, '--actor'),
    actorRole: flag(args, '--role') ?? 'pm',
    occurredAt: flag(args, '--at'),
    correlationId: flag(args, '--correlation'),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    if (error?.code === 'USAGE') {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 2
      return
    }
    process.stderr.write(`${JSON.stringify({
      error: error.code ?? 'CAPTURE_FAILED',
      message: error.message,
      diagnostics: error.errors ?? [],
    })}\n`)
    process.exitCode = 1
  })
}
