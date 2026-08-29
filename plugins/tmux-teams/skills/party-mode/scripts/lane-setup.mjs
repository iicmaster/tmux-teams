#!/usr/bin/env node
// The way out. `acp_lanes` and `acp_lane_probe` refuse a lane this machine
// cannot start and tell the operator to run setup; this is the thing they were
// pointing at, and until it existed that pointer named nothing.
//
//   node lane-setup.mjs check                     what is wrong, and what would fix it
//   node lane-setup.mjs set <lane> <key> <value>  write one override and RE-CHECK
//   node lane-setup.mjs show                      the current per-machine file
//
// WHY A SCRIPT AND NOT AN MCP TOOL. ADR 0007 draws its line at "answering
// questions is a different thing from a surface that can act on an operator's
// behalf". Reading readiness is answering, and the MCP server does that.
// WRITING a bin path is acting, so it lives out here — which is also what the
// instruction asked for: configure the bins so they appear as choices FOR MCP.
// MCP consumes this file; it does not write it.
//
// RE-CHECKING AFTER THE WRITE IS THE POINT, not a courtesy. A wizard that
// writes a value and declares success has moved the operator's problem, not
// solved it — the whole failure this release exists to end is a setting that
// looks applied and is not.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { REVIEW_PROFILES } from './review-profiles.mjs'
import { OVERRIDABLE_FIELDS, OVERRIDE_PATH, loadLaneOverrides, OVERRIDE_PROBLEMS } from './lane-overrides.mjs'
import { readinessReport, READINESS_PROBLEMS } from './lane-readiness.mjs'

const LANES = Object.keys(REVIEW_PROFILES)

// What an operator can actually do about each closed code. The repair differs
// per code and saying the wrong one sends them to the wrong place — the exact
// mistake the endpoint-before-executable ordering used to make.
const REPAIR = Object.freeze({
  executable_absent: lane =>
    `install the wrapper, or point this lane at one you have:\n`
    + `      node lane-setup.mjs set ${lane} claudeExecutable <the-name-on-your-PATH>`,
  executable_not_file: lane =>
    `the name resolves to something that is not a file — point the lane elsewhere:\n`
    + `      node lane-setup.mjs set ${lane} claudeExecutable <the-name-on-your-PATH>`,
  launcher_absent: lane =>
    `install the launcher, or use the other one:\n`
    + `      node lane-setup.mjs set ${lane} command '["npx","-y","<adapter-package>"]'`,
  binary_absent: () => 'install it — the plugin invokes this directly and nothing here can substitute for it',
})

const readOverrides = async () => {
  try { return JSON.parse(await readFile(OVERRIDE_PATH, 'utf8')) } catch { return {} }
}

async function check() {
  const report = readinessReport(REVIEW_PROFILES, process.env, { overrideLoader: loadLaneOverrides })
  const { problems } = loadLaneOverrides({ knownLanes: LANES })

  if (problems.length > 0) {
    // A broken override file is reported FIRST and alone. Everything below it
    // is computed from shipped defaults, because the file was refused whole —
    // showing lane results underneath would describe a configuration that is
    // not in effect.
    console.log(`\n  the per-machine file is not usable, so NONE of it is applied:\n  ${OVERRIDE_PATH}\n`)
    for (const p of problems) {
      console.log(`    ${p.code}${p.lane ? ` (lane ${p.lane}${p.field ? `, field ${p.field}` : ''})` : ''}`)
      console.log(`      ${OVERRIDE_PROBLEMS[p.code]}`)
    }
    console.log('\n  fix or delete that file, then run check again.\n')
    return 2
  }

  console.log(`\n  plugin: ${report.plugin.ready ? 'ready' : 'NOT ready'}`)
  for (const m of report.plugin.missing) {
    console.log(`    missing ${m.missing} — ${m.why}`)
    console.log(`      ${REPAIR.binary_absent()}`)
  }

  console.log(`\n  lanes callable on this machine: ${report.callableLanes.length}/${report.lanes.length}`)
  console.log(`  families callable: ${report.callableFamilies.length}`
    + (report.callableFamilies.length < 3 ? '  — a review panel needs three distinct families' : ''))
  console.log('')
  for (const lane of report.lanes) {
    const mark = lane.available ? 'ok  ' : 'NOT '
    console.log(`    ${mark} ${lane.lane.padEnd(11)} needs ${lane.needs.join(' + ') || '(nothing declared)'}`)
    for (const b of lane.blocking) {
      console.log(`         ${b.code}: ${b.missing}`)
      console.log(`         ${READINESS_PROBLEMS[b.code]}`)
      const repair = REPAIR[b.code]
      if (repair) console.log(`         ${repair(lane.lane)}`)
    }
  }
  console.log(`\n  per-machine file: ${OVERRIDE_PATH}`)
  // Say what is blocked, not whether SOMETHING is. `setupRequired` is a
  // whole-plugin gate — true when no lane at all can run — and printing
  // "nothing is blocking a dispatch" while one lane is dead is the same
  // half-truth this release keeps deleting from other places.
  const dead = report.lanes.filter(l => !l.available).map(l => l.lane)
  if (report.setupRequired) {
    console.log('  setup REQUIRED — nothing can be dispatched until the above is fixed.\n')
  } else if (dead.length > 0) {
    console.log(`  ${report.callableLanes.length} lanes can be dispatched.`
      + ` ${dead.length} cannot and will be refused before they start: ${dead.join(', ')}.\n`)
  } else {
    console.log('  every declared lane can be dispatched on this machine.\n')
  }
  return report.setupRequired ? 2 : 0
}

async function set(lane, key, rawValue) {
  if (!LANES.includes(lane)) {
    console.error(`no such lane: ${lane}\nknown: ${LANES.join(', ')}`)
    return 1
  }
  if (!OVERRIDABLE_FIELDS.includes(key)) {
    console.error(`not an overridable field: ${key}\noverridable: ${OVERRIDABLE_FIELDS.join(', ')}`)
    return 1
  }
  // `command` and `env` are JSON; the rest are plain strings. Parsing only the
  // two that need it keeps a wrapper name with a dot in it from being read as
  // JSON and refused for a reason the operator did not cause.
  let value = rawValue
  if (key === 'command' || key === 'env') {
    try { value = JSON.parse(rawValue) } catch {
      console.error(`${key} must be valid JSON — for example:\n  ${key === 'command'
        ? `'["npx","-y","@agentclientprotocol/codex-acp@1.1.7"]'`
        : `'{"NPM_CONFIG_CACHE":"/path/to/cache"}'`}`)
      return 1
    }
  }

  const current = await readOverrides()
  const next = { ...current, [lane]: { ...(current[lane] ?? {}), [key]: value } }
  await mkdir(dirname(OVERRIDE_PATH), { recursive: true })
  await writeFile(OVERRIDE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  console.log(`\n  wrote ${lane}.${key} to ${OVERRIDE_PATH}`)

  // THE RE-CHECK. Writing is not the outcome; the lane becoming callable is.
  const { problems } = loadLaneOverrides({ knownLanes: LANES })
  if (problems.length > 0) {
    console.log(`\n  the file is now UNUSABLE — ${problems[0].code}: ${OVERRIDE_PROBLEMS[problems[0].code]}`)
    console.log('  nothing in it is applied until that is fixed.\n')
    return 2
  }
  const report = readinessReport(REVIEW_PROFILES, process.env, { overrideLoader: loadLaneOverrides })
  const after = report.lanes.find(l => l.lane === lane)
  if (after?.available) {
    console.log(`  ${lane} is now callable on this machine.\n`)
    return 0
  }
  console.log(`  ${lane} is still NOT callable:`)
  for (const b of after?.blocking ?? []) console.log(`    ${b.code}: ${b.missing}`)
  console.log('')
  return 2
}

async function show() {
  const raw = await readFile(OVERRIDE_PATH, 'utf8').catch(() => null)
  if (raw === null) {
    console.log(`\n  no per-machine file yet: ${OVERRIDE_PATH}`)
    console.log('  that is the normal state — shipped defaults are in effect.\n')
    return 0
  }
  console.log(`\n  ${OVERRIDE_PATH}\n`)
  console.log(raw.split('\n').map(l => `    ${l}`).join('\n'))
  return 0
}

export async function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'check' || cmd === undefined) return check()
  if (cmd === 'show') return show()
  if (cmd === 'set') {
    if (rest.length < 3) {
      console.error('usage: node lane-setup.mjs set <lane> <key> <value>')
      return 1
    }
    return set(rest[0], rest[1], rest.slice(2).join(' '))
  }
  console.error('usage: node lane-setup.mjs [check|show|set <lane> <key> <value>]')
  return 1
}

// Compare realpaths on both sides: `import.meta.url` is percent-encoded and
// Node resolves it through symlinks, so a naive comparison answers no on a path
// containing a space and again on macOS /var.
const { realpathSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const { resolve } = await import('node:path')
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
  } catch { return false }
})()
if (invokedDirectly) process.exit(await main(process.argv.slice(2)))
