#!/usr/bin/env node
// Materialise the portable Agent Plugins 1.0 root as REAL FILES.
//
//   node scripts/portable-root.mjs <out-dir> [--force]
//
// WHY THIS EXISTS. `agent-plugins/tmux-teams/` is built entirely of symlinks
// into the Claude tree, and that is deliberate: two roots that share one copy
// of everything cannot drift into disagreeing, which is the failure a second
// hand-maintained layout would have shipped. But every one of those links
// points OUTSIDE the root it lives in (`../../plugins/...`), so the root is a
// view of this repository rather than a thing you can pick up. Measured:
//
//     git archive HEAD agent-plugins | tar -x -C /tmp/ar
//     /tmp/ar/agent-plugins/tmux-teams/plugin.json   -> dangling
//     /tmp/ar/agent-plugins/tmux-teams/skills        -> dangling
//
// An openai review lane found that on the v0.35.0 release diff, and it matters
// because the whole point of the second root is "install from there instead".
// A folder that breaks when you copy it does not answer that.
//
// So the repository keeps the links and this script hands out a copy with the
// links resolved. No drift in the tree, a self-contained directory when someone
// actually needs one — the two properties were only in conflict while there was
// nothing that could produce the second on demand.
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PORTABLE_SOURCE = join('agent-plugins', 'tmux-teams')

// `dereference: true` is the whole mechanism: it is what turns each link into
// the bytes behind it rather than copying the link itself, which is the one
// thing that would reproduce the dangling root in the destination.
export async function materialisePortableRoot(repoRoot, outDir, { force = false } = {}) {
  const source = join(repoRoot, PORTABLE_SOURCE)
  if (!existsSync(source)) throw new Error(`portable root not found: ${source}`)
  const destination = join(outDir, 'tmux-teams')
  if (existsSync(destination)) {
    // Refuse by default. This writes a whole directory tree, and a caller who
    // typed the wrong path should get a sentence rather than a deletion.
    if (!force) throw new Error(`refusing to overwrite ${destination} — pass --force to replace it`)
    await rm(destination, { recursive: true, force: true })
  }
  await mkdir(outDir, { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true })
  return destination
}

// realpath on BOTH sides: `import.meta.url` is resolved through symlinks by
// Node's ESM loader while argv[1] keeps the path as it was typed, so on macOS
// `/var` vs `/private/var` alone is enough to make a naive comparison answer no.
const invokedDirectly = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(argv1))
  } catch { return false }
})()

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const outDir = args.find(a => !a.startsWith('--'))
  if (!outDir) {
    console.error('usage: node scripts/portable-root.mjs <out-dir> [--force]')
    process.exit(1)
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const written = await materialisePortableRoot(repoRoot, resolve(outDir), { force })
    console.log(`portable root written: ${written}`)
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
}
