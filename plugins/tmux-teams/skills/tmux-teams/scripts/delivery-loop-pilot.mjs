#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

import {
  PilotValidationError,
  buildEvidencePack,
  createAssignmentEvent,
  createEligibilityEvent,
  createFreezeEvent,
  freezePilotManifest,
  replayPilot,
  validateFrozenManifest,
} from './delivery-loop-pilot-core.mjs'
import { canonicalDigest } from './delivery-loop-core.mjs'
import {
  appendEventAtomic,
  initializeStore,
  readBoundedFile,
  readJsonFile,
  readStore,
} from './delivery-loop-store.mjs'

function commandError(code, message, path = '') {
  return new PilotValidationError([{ code, path, message }], code)
}

function flag(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

function seedFrom(path) {
  if (!path) throw commandError('SEED_FILE_REQUIRED', 'A private seed file is required.', 'seed-file')
  const seed = readBoundedFile(path, 4096).toString('utf8').trim()
  if (seed.length < 16) throw commandError('ASSIGNMENT_SEED_INVALID', 'Seed file must contain at least 16 characters.', path)
  return seed
}

export function freezeStore({ draftPath, storeDir, seedPath, frozenAt }) {
  const draft = readJsonFile(draftPath)
  const seed = seedFrom(seedPath)
  if (Object.hasOwn(draft, 'assignment_seed') && draft.assignment_seed !== seed) {
    throw commandError('ASSIGNMENT_SEED_MISMATCH', 'Draft seed differs from the named seed file.', draftPath)
  }
  draft.assignment_seed = seed
  const manifest = freezePilotManifest(draft, { frozenAt })
  const initialized = initializeStore(storeDir, manifest)
  const freezeEvent = createFreezeEvent(manifest, {
    actorId: manifest.eligibility.eligibility_owner_actor_id,
  })
  const freezeResult = appendEventAtomic(storeDir, freezeEvent)
  return {
    store: initialized.store,
    created: initialized.created,
    experiment_id: manifest.experiment_id,
    manifest_digest: manifest.manifest_digest,
    seed_commitment: manifest.assignment.seed_commitment,
    freeze_event_id: freezeResult.event.event_id,
    automatic_routing: false,
  }
}

export function assignSlice({ storeDir, candidatePath, seedPath, assignedAt, actorId }) {
  const candidate = readJsonFile(candidatePath)
  const assignmentSeed = seedFrom(seedPath)
  let { manifest, events } = readStore(storeDir)
  const eligibilityEvent = createEligibilityEvent(manifest, candidate, {
    eligibleAt: manifest.assignment.assignment_window.start,
    actorId: manifest.eligibility.eligibility_owner_actor_id,
  })
  const eligibilityResult = appendEventAtomic(storeDir, eligibilityEvent)
  ;({ manifest, events } = readStore(storeDir))
  const event = createAssignmentEvent(manifest, events, candidate, {
    assignedAt,
    recordedAt: assignedAt,
    actorId,
    assignmentSeed,
  })
  const result = appendEventAtomic(storeDir, event)
  return {
    eligibility_event: eligibilityResult.event,
    eligibility_appended: eligibilityResult.appended,
    event: result.event,
    appended: result.appended,
    automatic_routing: false,
  }
}

export function replayStore({ storeDir, asOf }) {
  const { manifest, events } = readStore(storeDir)
  return replayPilot({ manifest, events, asOf })
}

export function rehearseStore({ storeDir, asOf, runs = 3 }) {
  if (!Number.isSafeInteger(runs) || runs < 3 || runs > 20) {
    throw commandError('REHEARSAL_RUNS_INVALID', 'Rehearsal requires between 3 and 20 runs.', 'runs')
  }
  const { manifest, events } = readStore(storeDir)
  const digests = []
  for (let index = 0; index < runs; index++) {
    digests.push(canonicalDigest(buildEvidencePack(manifest, events, { analysisAsOf: asOf })))
  }
  const deterministic = new Set(digests).size === 1
  if (!deterministic) throw commandError('REHEARSAL_NONDETERMINISTIC', 'Repeated evidence builds produced different digests.')
  return {
    runs,
    deterministic,
    evidence_bundle_digest: digests[0],
    both_arms_present: new Set(replayPilot({ manifest, events, asOf }).slices.map((slice) => slice.arm)).size === 2,
    automatic_routing: false,
  }
}

function usage() {
  return [
    'usage:',
    '  delivery-loop-pilot.mjs freeze <draft.json> --store <absolute-dir> --seed-file <file> --frozen-at <RFC3339>',
    '  delivery-loop-pilot.mjs assign <candidate.json> --store <absolute-dir> --seed-file <file> --assigned-at <RFC3339> --actor <id>',
    '  delivery-loop-pilot.mjs replay --store <absolute-dir> --as-of <RFC3339>',
    '  delivery-loop-pilot.mjs rehearse --store <absolute-dir> --as-of <RFC3339> [--runs 3]',
    '  delivery-loop-pilot.mjs verify-manifest --store <absolute-dir>',
  ].join('\n')
}

async function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const [command, positional, ...rest] = argv
  if (command === 'freeze' && positional) {
    const result = freezeStore({
      draftPath: positional,
      storeDir: flag(rest, '--store'),
      seedPath: flag(rest, '--seed-file'),
      frozenAt: flag(rest, '--frozen-at'),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (command === 'assign' && positional) {
    const result = assignSlice({
      candidatePath: positional,
      storeDir: flag(rest, '--store'),
      seedPath: flag(rest, '--seed-file'),
      assignedAt: flag(rest, '--assigned-at'),
      actorId: flag(rest, '--actor'),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  const args = positional ? [positional, ...rest] : rest
  if (command === 'replay') {
    process.stdout.write(`${JSON.stringify(replayStore({
      storeDir: flag(args, '--store'),
      asOf: flag(args, '--as-of'),
    }))}\n`)
    return
  }
  if (command === 'rehearse') {
    process.stdout.write(`${JSON.stringify(rehearseStore({
      storeDir: flag(args, '--store'),
      asOf: flag(args, '--as-of'),
      runs: Number(flag(args, '--runs') ?? 3),
    }))}\n`)
    return
  }
  if (command === 'verify-manifest') {
    const { manifest } = readStore(flag(args, '--store'))
    const validation = validateFrozenManifest(manifest)
    process.stdout.write(`${JSON.stringify(validation)}\n`)
    if (!validation.valid) process.exitCode = 1
    return
  }
  throw commandError('USAGE', usage())
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    if (error?.code === 'USAGE') {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 2
      return
    }
    process.stderr.write(`${JSON.stringify({
      error: error.code ?? 'PILOT_COMMAND_FAILED',
      message: error.message,
      diagnostics: error.errors ?? [],
    })}\n`)
    process.exitCode = 1
  })
}
