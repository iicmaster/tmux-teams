#!/usr/bin/env node
// Does the published roadmap page still match ROADMAP.md?
//
//   0 = current    2 = stale, publish it    1 = this script failed
//
// WHY THIS EXISTS. The roadmap lived only as an HTML page on a private host,
// with no source in this repository, no publish script, and nothing that could
// notice it had gone stale. It was regenerated whenever somebody remembered to
// dispatch an agent at it, which is not a process — it is a memory, and this
// project has now watched memory fail at the release panel, at a missing commit
// step, and at three rounds of documentation rot in one day. The thing that
// actually stopped those was never a better rule. It was a script that answers
// the question, and `gate-required.mjs` is the shape being copied here.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it never writes the marker. A gate that
// records its own answer passes forever — the same vacuous shape as a test that
// asserts a value it just computed. Recording is a separate, explicit act
// (`--record`), performed only after a publish actually happened.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROADMAP_SOURCE = 'ROADMAP.md'
export const ROADMAP_MARKER = '.roadmap-published.json'
export const MARKER_SCHEMA = 'tmux-teams.roadmap-published.v1'

export const ROADMAP_EXIT = Object.freeze({ current: 0, failed: 1, stale: 2 })

export function sourceDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Pure decision. `marker` is the parsed marker or null when absent.
 * Returns `{ stale, reason }` — `reason` is null when the page is current.
 */
export function classifyRoadmap(sourceBytes, marker) {
  const digest = sourceDigest(sourceBytes)
  if (marker === null || marker === undefined) {
    return { stale: true, digest, reason: `no ${ROADMAP_MARKER}: the page has never been recorded as published` }
  }
  if (typeof marker !== 'object' || Array.isArray(marker)) {
    return { stale: true, digest, reason: `${ROADMAP_MARKER} is not a JSON object` }
  }
  if (marker.schema !== MARKER_SCHEMA) {
    return { stale: true, digest, reason: `${ROADMAP_MARKER} schema is ${JSON.stringify(marker.schema)}, expected ${MARKER_SCHEMA}` }
  }
  if (typeof marker.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(marker.source_sha256)) {
    return { stale: true, digest, reason: `${ROADMAP_MARKER} carries no usable source_sha256` }
  }
  if (typeof marker.url !== 'string' || !marker.url.startsWith('https://')) {
    // A marker without the URL it was published to cannot be checked by a human
    // either, and this gate exists precisely because nobody could check it.
    return { stale: true, digest, reason: `${ROADMAP_MARKER} does not record an https url` }
  }
  if (marker.source_sha256 !== digest) {
    return {
      stale: true,
      digest,
      reason: `${ROADMAP_SOURCE} changed since the last publish (recorded ${marker.source_sha256.slice(0, 12)}…, current ${digest.slice(0, 12)}…)`,
    }
  }
  return { stale: false, digest, reason: null }
}

const readMarker = (path) => {
  let raw
  try { raw = readFileSync(path, 'utf8') } catch { return null }
  try { return JSON.parse(raw) } catch { return { schema: '<unparseable>' } }
}

export function runRoadmapGateCli(argv = [], {
  root = process.cwd(),
  stdout = process.stdout,
  now = () => new Date().toISOString(),
} = {}) {
  const sourcePath = join(root, ROADMAP_SOURCE)
  const markerPath = join(root, ROADMAP_MARKER)
  let bytes
  try { bytes = readFileSync(sourcePath) } catch (error) {
    stdout.write(`roadmap-gate: cannot read ${ROADMAP_SOURCE}: ${error.message}\n`)
    return ROADMAP_EXIT.failed
  }

  if (argv[0] === '--record') {
    const url = argv[1]
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      stdout.write('roadmap-gate: usage: roadmap-gate.mjs --record <https url of the published page>\n')
      return ROADMAP_EXIT.failed
    }
    const marker = {
      schema: MARKER_SCHEMA,
      source_sha256: sourceDigest(bytes),
      url,
      published_at: now(),
    }
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8' })
    stdout.write(`roadmap-gate: recorded ${marker.source_sha256.slice(0, 12)}… published to ${url}\n`)
    return ROADMAP_EXIT.current
  }

  const verdict = classifyRoadmap(bytes, readMarker(markerPath))
  if (!verdict.stale) {
    stdout.write(`roadmap-gate: published page is current (${verdict.digest.slice(0, 12)}…)\n`)
    return ROADMAP_EXIT.current
  }
  stdout.write(`roadmap-gate: STALE — ${verdict.reason}\n\n`)
  stdout.write(`Publish ${ROADMAP_SOURCE} to the artifact host, then record it:\n\n`)
  stdout.write(`    node scripts/roadmap-gate.mjs --record <https url>\n\n`)
  stdout.write('The gate never records for you: a gate that writes its own answer passes forever.\n')
  return ROADMAP_EXIT.stale
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const here = dirname(fileURLToPath(import.meta.url))
  process.exitCode = runRoadmapGateCli(process.argv.slice(2), { root: join(here, '..') })
}
