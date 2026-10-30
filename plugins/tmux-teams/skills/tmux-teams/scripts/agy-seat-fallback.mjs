#!/usr/bin/env node
// The 2026-10-21 quota death, and the classifier it forced into existence. A
// real dispatch (task id `pmd-review-agy`, ACP_MODEL=gemini-4-argon-high) died
// on the Antigravity individual quota with `RESOURCE_EXHAUSTED (code 429):
// Individual quota reached` in its runner log — and with a liveness record
// whose `liveness_state` said `failed` but whose `termination_reason` said
// only `protocol_error`. THE REASON FIELD IS THE RED HERRING: it names the
// protocol frame the companion died on, not the provider condition underneath,
// so in the measured event the runner log was the ONLY source that matched. A
// classifier that reads the liveness record alone misses every one of these.
//
// Master's order (2026-10-30): when the gemini-4 seat hits the provider limit,
// fall back to the gemini-3.8 flash seat at the SAME effort tier IMMEDIATELY
// and TELL the operator — the work keeps moving. The codex and claude siblings
// keep their never-downgrade rules; this is the ordered exception, and
// rate-limit evidence is its only trigger.
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeTaskId, livenessPath, logPath, readLeafSync } from './acp-dispatch.mjs'

export const USAGE = [
  'usage: node agy-seat-fallback.mjs seat <model>',
  '       node agy-seat-fallback.mjs rate-limited <cwd> <task-id>',
].join('\n')

// Same tier on both sides, by construction: `high` maps to `high`, `medium` to
// `medium`, `low` to `low`. A quota death is not a reason to change the
// operator's effort choice, and a mapping table that could express a tier
// change is a table that will eventually be asked to.
export const SEAT_FALLBACKS = Object.freeze({
  'gemini-4-argon-high': 'gemini-3.8-flash-high',
  'gemini-4-argon-medium': 'gemini-3.8-flash-medium',
  'gemini-4-argon-low': 'gemini-3.8-flash-low',
})

// Null for ANYTHING else, and that set is load-bearing. The 3.8 flash seats
// themselves map to null — there is no second hop, because the order that
// authorises one fallback authorises exactly one. A 3.1 value maps to null
// because `SEAT_FALLBACKS` cannot produce one, and no caller may ask this
// table for what it structurally never contains.
export function fallbackSeat(model) {
  if (typeof model !== 'string') return null
  // `hasOwnProperty`, not a bare lookup: this map is a frozen object LITERAL,
  // and a literal still inherits `constructor` and `toString` from
  // `Object.prototype`. `SEAT_FALLBACKS['constructor']` is a truthy function,
  // and a fallback answer that returns `Object` is worse than none.
  return Object.prototype.hasOwnProperty.call(SEAT_FALLBACKS, model) ? SEAT_FALLBACKS[model] : null
}

// The measured strings from the 2026-10-21 log, not a paraphrase of them:
// `RESOURCE_EXHAUSTED` (the underscore form the API writes, and the spaced
// form a rendered copy can carry), a STANDALONE `429` — as in
// `"error_code":429` and `(code 429)`, never `4291` or `1429`, which is what
// the lookarounds are for — `quota reached`, `rate limit` in its spaced,
// underscored and smashed spellings, and `too many requests`.
// Deliberately NOT matched: `protocol_error` (the red herring itself),
// `model not found`, `identity mismatch`, `EACCES` — every one of those
// fails closed with no fallback, and a classifier that fires the fallback on
// them re-runs a dispatch that was refused for a reason a cheaper seat cannot
// fix.
const RATE_LIMIT_EVIDENCE = new RegExp([
  'resource[\\s_-]*exhausted',
  '(?<![0-9])429(?![0-9])',
  'quota[\\s_-]*reached',
  'rate[\\s_-]*limit',
  'too[\\s_-]*many[\\s_-]*requests',
].join('|'), 'i')

export function isRateLimitEvidence(text) {
  return typeof text === 'string' && RATE_LIMIT_EVIDENCE.test(text)
}

// ~240 characters: enough for the whole measured AGY_ERROR line (183 in the
// log this classifier was built against), and short enough that an excerpt
// stays a line an operator reads rather than a blob they scroll.
const EXCERPT_CAP = 240

const capExcerpt = (text) => text.trim().slice(0, EXCERPT_CAP)

// Every rate-limit marker this file knows, measured 2026-10-21. Fields, then
// the log, and BOTH — in the real event the liveness fields said only
// `protocol_error` and the log was the sole match, but a liveness record whose
// error string carries the 429 is still honoured: `where` reports which source
// produced the excerpt so an operator can go read the other one.
export function rateLimitEvidence(cwd, taskId) {
  // The same rule `acp-dispatch.mjs` applies, at the boundary that builds the
  // paths: a `../` task id here reads runner logs this run never wrote.
  if (!safeTaskId(taskId)) {
    throw Object.assign(
      new Error(`invalid task id — 1-64 chars, alphanumeric/_/-, starts alphanumeric or _`),
      { code: 'invalid_task_id' },
    )
  }
  // Liveness FIRST. Its `termination_reason` missed the measured event, but an
  // `error` field carrying the provider string is evidence the log may not
  // outlive — a cleaned run root with a surviving liveness leaf is a real
  // shape, and reading only the log is the mirror image of the mistake this
  // classifier exists to fix.
  const livenessText = readLeafSync(livenessPath(cwd, taskId), cwd)
  if (livenessText !== null) {
    let record = null
    try { record = JSON.parse(livenessText) } catch { record = null }
    // `termination_reason` AND the error string fields, not one of them: the
    // reason is the frame the companion died on, the error is what it died OF.
    const fields = [record?.termination_reason, record?.error,
      ...(typeof record?.error?.message === 'string' ? [record.error.message] : [])]
    for (const field of fields) {
      if (typeof field === 'string' && isRateLimitEvidence(field)) {
        return { rateLimited: true, where: 'liveness', excerpt: capExcerpt(field) }
      }
    }
  }
  // The runner log, WHOLE rather than a tail. `readLeafSync` is the one read
  // boundary this tree has, and a tail would be a second partial-read path
  // against the same leaf with its own off-by-a-window way of missing the
  // line — the measured quota log was a few KiB end to end, and the excerpt
  // is the FIRST matching line, so the scan stops where the evidence does.
  const logText = readLeafSync(logPath(cwd, taskId), cwd)
  if (logText !== null) {
    for (const line of logText.split('\n')) {
      if (isRateLimitEvidence(line)) {
        return { rateLimited: true, where: 'log', excerpt: capExcerpt(line) }
      }
    }
  }
  // Absence of evidence is NOT evidence of a rate limit. A verdict of `false`
  // here means the dispatch keeps failing closed exactly as it did before
  // this file existed — the fallback never fires on "cannot tell".
  return { rateLimited: false, where: null, excerpt: '' }
}

async function main(argv, { out = console.log, err = console.error } = {}) {
  const [mode, a, b] = argv

  if (mode === 'seat') {
    if (!a) { err(USAGE); return 2 }
    const seat = fallbackSeat(a)
    if (seat === null) {
      err(`no fallback exists for seat "${a}" — the gemini-3.8 flash seats are the last hop, `
        + 'and a seat outside the gemini-4 argon family is never downgraded to')
      return 2
    }
    out(seat)
    return 0
  }

  if (mode === 'rate-limited') {
    if (!a || !b) { err(USAGE); return 2 }
    // The operator-facing half of the rule `rateLimitEvidence` enforces.
    if (!safeTaskId(b)) {
      err(`invalid task id "${b}" — 1-64 chars, alphanumeric/_/-, starts alphanumeric or _`)
      return 2
    }
    let root
    try {
      root = realpathSync(resolve(a))
    } catch (cause) {
      err(`cannot resolve the run directory ${a}: ${cause.code ?? cause.message}`)
      return 2
    }
    const verdict = rateLimitEvidence(root, b)
    if (!verdict.rateLimited) {
      // Exit 1, the "asked and the answer is no" code: no evidence is a
      // VERDICT, not a failure to run, and a caller that cannot tell those
      // apart will re-dispatch on a refusal.
      out('no rate-limit evidence in liveness or runner log')
      return 1
    }
    out(`rate-limited (${verdict.where}): ${verdict.excerpt}`)
    return 0
  }

  err(USAGE)
  return 2
}

// The same direct-run guard `acp-dispatch.mjs` uses, against THIS module's own
// URL — importing theirs would ask whether acp-dispatch.mjs was the entry,
// which is never the question here.
function launchedDirectly(entry = process.argv[1]) {
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry))
  } catch {
    return false
  }
}

if (launchedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((cause) => {
      console.error(cause?.message ?? String(cause))
      process.exitCode = 2
    })
}
