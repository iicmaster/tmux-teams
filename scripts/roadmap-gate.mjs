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
import { PAGES, normalisePage } from './roadmap-render.mjs'

// Every page in `roadmap-render.mjs`'s PAGES list needs its own record, or a
// gate that says "current" is only telling you about one of them. Keyed by
// source path; the roadmap keeps the bare shape it has always had so an existing
// marker stays readable.
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
export function classifyRoadmap(sourceBytes, marker, markerName = ROADMAP_MARKER, sourceName = ROADMAP_SOURCE) {
  const digest = sourceDigest(sourceBytes)
  if (marker === null || marker === undefined) {
    return { stale: true, digest, reason: `no ${markerName}: the page has never been recorded as published` }
  }
  if (typeof marker !== 'object' || Array.isArray(marker)) {
    return { stale: true, digest, reason: `${markerName} is not a JSON object` }
  }
  if (marker.schema !== MARKER_SCHEMA) {
    return { stale: true, digest, reason: `${markerName} schema is ${JSON.stringify(marker.schema)}, expected ${MARKER_SCHEMA}` }
  }
  if (typeof marker.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(marker.source_sha256)) {
    return { stale: true, digest, reason: `${markerName} carries no usable source_sha256` }
  }
  if (typeof marker.url !== 'string' || !marker.url.startsWith('https://')) {
    // A marker without the URL it was published to cannot be checked by a human
    // either, and this gate exists precisely because nobody could check it.
    return { stale: true, digest, reason: `${markerName} does not record an https url` }
  }
  if (marker.source_sha256 !== digest) {
    return {
      stale: true,
      digest,
      reason: `${sourceName} changed since the last publish (recorded ${marker.source_sha256.slice(0, 12)}…, current ${digest.slice(0, 12)}…)`,
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
  // Which page. Default is the roadmap, so every existing invocation and the
  // release flow's step keep working unchanged; naming another source checks
  // that one. A gate that only ever answered about one of three published pages
  // was telling the truth about a third of the question.
  const positional = argv.filter((arg, i) => !arg.startsWith('--') && !argv[i - 1]?.startsWith('--record'))
  const source = normalisePage(positional[0] ?? ROADMAP_SOURCE)
  // The page list is the authority. An undeclared source used to be checked
  // against a marker derived from whatever string was typed, so a typo answered
  // STALE about a page that does not exist and a second spelling of a real page
  // kept its own separate record. Refuse instead of guessing.
  if (!PAGES.some((page) => page.source === source)) {
    stdout.write(`roadmap-gate: ${source} is not a declared page. Known pages:\n`)
    for (const page of PAGES) stdout.write(`    ${page.source}\n`)
    return ROADMAP_EXIT.failed
  }
  const sourcePath = join(root, source)
  const markerPath = join(root, source === ROADMAP_SOURCE
    ? ROADMAP_MARKER
    : `.published-${source.split('/').pop().replace(/\.md$/, '')}.json`)
  let bytes
  try { bytes = readFileSync(sourcePath) } catch (error) {
    stdout.write(`roadmap-gate: cannot read ${source}: ${error.message}\n`)
    return ROADMAP_EXIT.failed
  }

  // Found by using it: this asked whether argv[0] was `--record`, so naming a
  // source first — the only way to record any page but the roadmap — silently
  // fell through to the check branch and recorded nothing, while printing STALE
  // as though nothing had been asked.
  // Both forms: `--record <url>` and `--record=<url>`. A lane found the second
  // silently doing nothing, which is the same shape as the argv[0] bug this
  // replaced — a command that accepts an instruction and ignores it.
  const recordIndex = argv.findIndex((arg) => arg === '--record' || arg.startsWith('--record='))
  if (recordIndex >= 0) {
    const inline = argv[recordIndex].startsWith('--record=') ? argv[recordIndex].slice('--record='.length) : null
    const url = inline ?? argv[recordIndex + 1]
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

  const verdict = classifyRoadmap(bytes, readMarker(markerPath), markerPath.split('/').pop(), source)
  if (!verdict.stale) {
    stdout.write(`roadmap-gate: published page is current (${verdict.digest.slice(0, 12)}…)\n`)
    return ROADMAP_EXIT.current
  }
  stdout.write(`roadmap-gate: STALE — ${verdict.reason}\n\n`)
  stdout.write(`Publish ${source} to the artifact host, then record it:\n\n`)
  stdout.write(`    node scripts/roadmap-gate.mjs --record <https url>\n\n`)
  stdout.write('The gate never records for you: a gate that writes its own answer passes forever.\n')
  return ROADMAP_EXIT.stale
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const here = dirname(fileURLToPath(import.meta.url))
  process.exitCode = runRoadmapGateCli(process.argv.slice(2), { root: join(here, '..') })
}
